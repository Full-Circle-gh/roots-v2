#!/usr/bin/env node
/**
 * Recipes on the phone, read-only (§164's screen, stage one).
 *
 *   node scripts/test_mobile_recipes.js
 *
 * The desktop Recipes screen is 3,000 lines and four sub-tabs; what crosses to
 * a phone is the half a person standing at a bench needs — what a thing is made
 * from, in what quantities, in what order.
 *
 * WHAT CAN GO WRONG, and each has a case:
 *
 *   • MONEY APPEARING ON IT. This screen draws no cost figure for anybody,
 *     whatever they hold. §164 split `recipes:costs` out so the kitchen could
 *     have the ingredients WITHOUT the batch cost and the margin; a phone that
 *     printed them would hand back exactly what the split withheld, and it
 *     would do it to the operator the split was for.
 *   • THE ROW GATED ON THE WRONG KEY. `recipes:costs` would refuse the screen
 *     to the person it was built for. `recipes:view` is the key that opens a
 *     recipe.
 *   • THE ROW LANDING UNGATED. It is born behind the `production` Features
 *     switch — the one that already gates Materials and Recipes on the desktop
 *     and `askbuy` in this same group. A new row may be born gated; an old one
 *     may not be gated retroactively, so this is the only moment it can happen.
 *   • THE SEARCH FIELD BEING REBUILT UNDER A TYPING OPERATOR. render() replaces
 *     the whole app with innerHTML, which destroys the input and takes the soft
 *     keyboard with it. The filter runs over rows already in memory, so the
 *     handler patches the list alone — the arrangement screenLogBatch() uses.
 *   • A STALE RECORD. Recipes are written on desktop; the copy in hand may be
 *     an hour old and the person is about to make the thing.
 *
 * READS ONLY — no browser, so this runs in the FAST shard and is part of the
 * gate.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MHTML = fs.readFileSync(path.join(ROOT, 'public', 'm.html'), 'utf8');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function section(t) { console.log('\n' + t); }

// The two screens, sliced so an assertion about one cannot be satisfied by the
// other or by anything else in a 22,000-line file.
function slice(from, to) {
  const a = MHTML.indexOf(from);
  assert.notStrictEqual(a, -1, `not found in m.html: ${from}`);
  const b = MHTML.indexOf(to, a + from.length);
  assert.notStrictEqual(b, -1, `not found after ${from}: ${to}`);
  return MHTML.slice(a, b);
}
// COMMENTS ARE NOT CODE, and the money assertions below are the reason this
// matters. The block comment above screenRecipeOne() explains that the money tab
// is NOT drawn — and an assertion reading raw source found "Cost & Pricing" in
// that sentence and failed a screen that is correct. A test that cannot tell a
// comment from a call gets "fixed" by deleting the prose, which is the wrong
// repair to have available on a file whose comments carry the reasoning. Same
// fault, same fix, as test_recipe_record_autosave.js's byte-window slice.
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments, including the HTML-ish ones
    .replace(/^[ \t]*\/\/.*$/gm, ' ');    // whole-line // comments
}

const LIST   = slice('function screenRecipes()', 'function rcpBodyHtml()');
const BODY   = slice('function rcpBodyHtml()', 'const RCP_STORAGE=');
const RECORD = slice('function screenRecipeOne()', 'SUBS.recipes=');
const SCREENS = codeOnly(LIST + BODY + RECORD);

// ═══════════════════════════════════════════════════════════════════════════
section('1. The row, and what it is gated on');
// ═══════════════════════════════════════════════════════════════════════════

const GROUPS = slice('const MORE_GROUPS=[', 'function moreGroups()');

check('there is a Recipes row', () => {
  assert.match(GROUPS, /\['recipes','book-open','Recipes','食谱'/);
});

// The kitchen's own group. Recipes belongs with Kitchen queue and Log a batch
// because all three are about making the thing, which is what §121's grouping
// is for: position says what a row is, so no row needs a subtitle.
check('it sits in "Making things", with the kitchen queue and the batch log', () => {
  const making = GROUPS.slice(GROUPS.indexOf("{h:['Making things'"));
  const next = making.indexOf("{h:['", 5);
  const group = next === -1 ? making : making.slice(0, next);
  assert.match(group, /'recipes'/, 'Recipes is not in Making things');
  assert.match(group, /'kitchenqueue'/);
  assert.match(group, /'logbatch'/);
});

// BORN GATED. The sixth element is the Features switch; moreGroups() filters on
// featOn(r[5]). This is the only moment the gate can be added — an old row
// cannot be gated retroactively.
check('it is born behind the `production` switch, like askbuy in the same list', () => {
  assert.match(GROUPS, /\['recipes','book-open','Recipes','食谱',null,'production'\]/);
  assert.match(GROUPS, /'askbuy'[^\]]*'production'/, 'askbuy should still carry the same switch');
});

check('and the screen itself refuses when the switch is off', () => {
  assert.match(LIST, /if\(!featOn\('production'\)\) return flagGate\('production'\);/,
    'the row can be reached by search and by the Quick-actions picker, so the screen carries the gate too');
});

section('2. The capability');

const CAPS = slice('const ROUTE_CAP={', 'function canRoute(');

// recipes:view, NOT recipes:costs. §164 split them so the kitchen could have
// the ingredients without the money; gating this screen on the money key would
// refuse it to exactly the person it was built for.
check('both routes are gated on `recipes:view`', () => {
  assert.match(CAPS, /recipes:'recipes:view'/);
  assert.match(CAPS, /recipeone:'recipes:view'/);
});

check('and NOT on `recipes:costs` — that would refuse the screen to the kitchen', () => {
  assert.doesNotMatch(CAPS, /recipes(one)?:'recipes:costs'/);
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. No money on this screen, for anybody');
// ═══════════════════════════════════════════════════════════════════════════

// THE LOAD-BEARING CASE. Not a capability check — a fact about what the screen
// draws. If any of these ever appears here, §164's split has been undone on the
// one surface it was made for.
const MONEY_READS = [
  'batchCost', 'costPerGram', 'costPerServing', 'marginPerServing',
  'master_cost', 'unit_cost', 'sell_price', 'suggestedSellPrice',
  'foodCostPct', 'overheadPct', 'labour', 'costData',
];
for (const key of MONEY_READS) {
  check(`the screens never read \`${key}\``, () => {
    assert.ok(SCREENS.indexOf(key) === -1,
      `${key} appears in the recipes screens — this screen draws no money for anyone`);
  });
}

check('and they call none of the phone\'s money helpers', () => {
  assert.doesNotMatch(SCREENS, /\bmoney0?\(/, 'money() has no business on this screen');
  assert.doesNotMatch(SCREENS, /acMoney|CUR\b/);
});

// The quantities ARE rendered, and by a helper of their own — a weight is not
// money and must not borrow money's formatter.
check('quantities go through rcpNum, which is a number helper and not a money one', () => {
  assert.match(MHTML, /const rcpNum = v => \{ const n=Number\(v\);/);
  assert.match(RECORD, /rcpNum\(l\.qty\)/, 'the line quantity');
  assert.match(MHTML, /rcpNum\(rec\.batch_size\)/, 'the batch size in the status line');
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. The list');
// ═══════════════════════════════════════════════════════════════════════════

check('it filters rows already in memory rather than re-asking the server', () => {
  assert.match(MHTML, /function rcpRows\(\)\{[\s\S]{0,600}rows\.filter/);
});

// THE FIELD IS NOT REBUILT WHILE SOMEBODY IS TYPING INTO IT. render() replaces
// the app with innerHTML and takes the soft keyboard with it; the rows are
// already in memory, so the handler patches the list alone.
check('typing patches the list and leaves the input alone', () => {
  const h = slice("reg('rcpSearch'", "reg('rcpType'");
  assert.match(h, /getElementById\('mRcpBody'\)/, 'it must patch the body');
  assert.doesNotMatch(h, /^\s*render\(\);\s*$/m, 'and must not call a bare render()');
  assert.match(h, /state\.focus=\{id:'mRcpQ'/, 'the caret is carried across the patch');
});

// REPORTED OFF A PHONE, 2026-09-17: "Spreads & Dips 涂抹酱和蘸酱 · 652.82 g ·
// 4 ser…" — the row truncates, and the filing was eating the two facts somebody
// opens this screen for. recipes.category is ONE TEXT column holding both
// languages (unlike store_products' name/name_cn, which catName() can pick a
// half from), so there is nothing to shorten. Ordering is the fix.
check('the weight and the servings come before the category, so truncation eats the filing', () => {
  const fn = slice('function rcpMeta(x)', 'function screenRecipes()');
  const body = codeOnly(fn);
  const batch = body.indexOf('x.batch_size');
  const serv  = body.indexOf('x.servings');
  const cat   = body.indexOf('x.category');
  assert.ok(batch !== -1 && serv !== -1 && cat !== -1, 'all three parts must be on the line');
  assert.ok(batch < cat, 'the batch weight must be pushed before the category');
  assert.ok(serv  < cat, 'and so must the servings');
});

// A row states what it has and omits what it does not — a recipe with no
// serving count prints no "— servings", which on a truncating line would spend
// the width that the weight needs.
check('each part is dropped when it is not recorded, rather than dashed', () => {
  const body = codeOnly(slice('function rcpMeta(x)', 'function screenRecipes()'));
  assert.match(body, /if\(x\.batch_size\)/);
  assert.match(body, /if\(x\.servings\)/);
  assert.match(body, /if\(x\.category\)/);
  assert.doesNotMatch(body, /'—'/);
});

check('the Made/Repacked chips are filing only, and are dropped when there is nothing to file', () => {
  assert.match(MHTML, /function rcpChips\(\)\{[\s\S]{0,500}if\(made\) out\.push/);
  assert.match(MHTML, /if\(rep\) out\.push/);
  assert.match(BODY, /chips\.length>1\?/, 'one chip is not a choice, so the row is not drawn');
});

// §1.12 — a section with bad data says so rather than falling through to the
// empty state, which would read as "this shop has no recipes".
check('a failed load says so, and does not read as an empty catalogue', () => {
  assert.match(BODY, /if\(r\.err\)/);
  assert.match(MHTML, /Could not load recipes\.','无法加载食谱。'/);
  const errAt = BODY.indexOf('if(r.err)');
  const emptyAt = BODY.indexOf('No recipes yet');
  assert.ok(errAt !== -1 && errAt < emptyAt, 'the error branch must come before the empty state');
});

check('an empty catalogue points at the desktop rather than offering a create', () => {
  assert.match(BODY, /No recipes yet','暂无食谱'/);
  assert.doesNotMatch(BODY, /cta|APP\.cmd\('rcpNew'/, 'there is no create on this screen');
});

// ═══════════════════════════════════════════════════════════════════════════
section('5. The record');
// ═══════════════════════════════════════════════════════════════════════════

check('it carries two tabs — Ingredients and Steps — and not the desktop\'s four', () => {
  assert.match(RECORD, /\['ingredients','Ingredients','原料'/);
  assert.match(RECORD, /\['steps','Steps','步骤'/);
  assert.doesNotMatch(codeOnly(RECORD), /Cost & Pricing|成本与定价/,
    'the money tab is not this screen\'s to draw');
});

// A recipe is edited on desktop, so the copy in hand may be an hour old and the
// person holding the phone is about to make the thing.
check('it is re-read on every entry, not carried from the last one opened', () => {
  const push = slice('function push(route){', 'function pop(){');
  assert.match(push, /if\(route==='recipeone'\)\{ const r=state\.rcp; r\.rec=null; r\.recTried=false;/);
});

check('the catalogue is kept across entries but the filters are dropped', () => {
  const push = slice('function push(route){', 'function pop(){');
  assert.match(push, /if\(route==='recipes'\)\{ const r=state\.rcp; r\.q=''; r\.type=''; \}/);
  assert.doesNotMatch(push, /if\(route==='recipes'\)\{[^}]*r\.rows=null/,
    're-reading 205 recipes on every entry is a wait for nothing');
});

check('the status line states the batch and the servings, or says nothing at all', () => {
  const sub = slice('SUBS.recipeone=', "reg('rcpSearch'");
  assert.match(sub, /if\(rec\.batch_size\)/);
  assert.match(sub, /if\(rec\.servings\)/);
  assert.match(sub, /bits\.join\(' · '\)/);
  assert.doesNotMatch(sub, /'—'/, '§1.7 — a status line is a fact or it is nothing');
});

check('Back names the list it came from', () => {
  const sub = slice('SUBS.recipeone=', "reg('rcpSearch'");
  assert.match(sub, /backLabel:\(\)=>T\('Recipes','食谱'\)/);
});

check('both screens say where a recipe is actually edited', () => {
  assert.match(BODY, /desktopNote\(\)/);
  assert.match(RECORD, /desktopNote\(\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
section('6. Bilingual, and sourced');
// ═══════════════════════════════════════════════════════════════════════════

// Every label on this screen is a pair. The ones lifted from the desktop screen
// are asserted by their Chinese half, so a retyped variant fails rather than
// passing as "close enough" — §155's rule is that a pair is one text node.
const LIFTED = [
  ['Recipes', '食谱'], ['Ingredients', '原料'], ['Steps', '步骤'],
  ['Storage', '储存方式'], ['Shelf life', '保质期'], ['Notes', '备注'],
  ['Made', '自制'], ['Repacked', '分装'],
];
for (const [en, zh] of LIFTED) {
  check(`${en} · ${zh} is the desktop's own pair`, () => {
    // Two shapes are in use and both are the pair: T('Made','自制') inline, and
    // the chip rows' {en:'Made',zh:'自制'}. Either satisfies this; a retyped
    // Chinese half satisfies neither, which is the point.
    assert.ok(SCREENS.indexOf(zh) !== -1
           || MHTML.indexOf(`'${en}','${zh}'`) !== -1
           || MHTML.indexOf(`en:'${en}',zh:'${zh}'`) !== -1,
      `${en} · ${zh} not found`);
    const desktop = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '19-recipes.js'), 'utf8');
    assert.ok(desktop.indexOf(zh) !== -1, `${zh} is not the desktop's word — it was retyped, not lifted`);
  });
}

check('the two composed pairs are the ones declared in the vocabulary', () => {
  assert.match(MHTML, /'Search recipes','搜索食谱'/);
  assert.match(MHTML, /'Could not load recipes\.','无法加载食谱。'/);
});

// ═══════════════════════════════════════════════════════════════════════════
section('7. Making one (§167) — stage two');
// ═══════════════════════════════════════════════════════════════════════════

const MAKE  = slice('function screenRecipeMake()', 'function rcpMakeOnTop()');
const SHEET = slice('function sheetRecipeStep()', 'SUBS.recipemake=');
const MAKING = codeOnly(MAKE + SHEET);

check('it is gated on `recipes:view` like the two screens it follows', () => {
  assert.match(CAPS, /recipemake:'recipes:view'/);
});

// NOTHING IS WRITTEN. The scale and the ticks are facts about this afternoon,
// not about the recipe. If this screen ever gains a save, it gains a way to
// damage a recipe from a phone — and §164's addendum is what that costs.
check('it writes nothing — no POST, no PUT, no save of any kind', () => {
  assert.doesNotMatch(MAKING, /apiPost|apiSend|method:\s*'(POST|PUT|PATCH|DELETE)'/,
    'Making one is read-only; the recipe on the server is untouched by scaling it');
  assert.doesNotMatch(MAKING, /\bsave[A-Z]/);
});

check('and it draws no money either, the same as the two screens before it', () => {
  for (const key of MONEY_READS) {
    assert.ok(MAKING.indexOf(key) === -1, `${key} appears in Making one`);
  }
  assert.doesNotMatch(MAKING, /\bmoney0?\(|acMoney/);
});

check('the scale multiplies on screen and is never stored', () => {
  assert.match(MHTML, /function rcpScaled\(v\)\{ return \(Number\(v\)\|\|0\)\*\(Number\(state\.rcp\.scale\)\|\|1\); \}/);
  assert.match(MAKE, /rcpScaled\(l\.qty\)/, 'each line is scaled');
  assert.match(MHTML, /rcpScaled\(rec\.batch_size\)/, 'and so is the batch');
});

// Half steps, because half a batch is the commonest thing anybody asks of a
// recipe. Clamped at both ends — a multiplier with no ceiling prints a shopping
// list nobody can carry.
check('the stepper moves in halves and is clamped at both ends', () => {
  const h = slice("reg('rcpScale'", "reg('rcpGot'");
  assert.match(h, /Math\.max\(0\.5,Math\.min\(20,/);
  assert.match(h, /Math\.round\(\(r\.scale\+0\.5\*Number\(d\)\)\*2\)\/2/);
});

check('entering resets the scale and the ticks — yesterday\'s half-gathered list is worse than none', () => {
  const push = slice('function push(route){', 'function pop(){');
  assert.match(push, /if\(route==='recipemake'\)\{ const r=state\.rcp; r\.scale=1; r\.got=\{\}; r\.step=null; \}/);
});

section('The step sheet');

check('the step counter is the app\'s own live pair, not a new one', () => {
  assert.match(SHEET, /'Step '\+\(i\+1\)\+' of '\+steps\.length,'第 '\+\(i\+1\)\+' 步,共 '\+steps\.length\+' 步'/);
  // The broadcast composer has carried this pair since v1.x — asserted so a
  // later edit there cannot silently orphan this one.
  assert.match(MHTML, /T\('Step 1 of 4','第 1 步,共 4 步'\)/,
    'the pair this lifts from must still be live');
});

check('Back, Next and Done are all lifted pairs', () => {
  assert.match(MHTML, /T\('Back','返回'\)/);
  assert.match(MHTML, /T\('Next','下一步'\)/);
  assert.match(MHTML, /T\('Done','完成'\)/);
});

// THE MOCKUP DREW TWO THINGS THE DATA CANNOT BACK. recipe_steps holds id,
// recipe_id, step_number, name and instructions — there is no step→ingredient
// link and no timer. Drawing either would have been invention dressed as data.
check('it invents no per-step ingredient list — the schema has no such link', () => {
  assert.doesNotMatch(MAKING, /This step uses|本步用到|步骤用料/);
});
check('and no rest timer, for the same reason', () => {
  assert.doesNotMatch(MAKING, /Rest \d|静置|计时/);
});

check('the sheet belongs to its screen and cannot paint over the record', () => {
  assert.match(MHTML, /if\(state\.rcp\.step!=null && rcpMakeOnTop\(\)\) html \+= sheetRecipeStep\(\);/);
  assert.match(MHTML, /function rcpMakeOnTop\(\)\{[\s\S]{0,200}top\.route==='recipemake'/);
});

section('The finish hands off rather than inventing a second write');

// What a recipe PRODUCES is not settled: it may back a material, feed several
// products at different pack sizes, or neither. logbatch already answers that
// in product units and is tested doing it.
check('it opens the existing Log a batch screen', () => {
  assert.match(MAKE, /APP\.cmd\('push','logbatch'\)/);
  assert.match(MAKE, /T\('Log a batch','登记批次'\)/, 'and reuses that row\'s own pair');
});

check('offered only to somebody who could actually use it', () => {
  assert.match(MAKE, /canRoute\('logbatch'\)\?/,
    'logbatch is gated on production:log, which a recipes:view holder need not have');
});

check('the way in is offered only when there is something to work through', () => {
  const sub = slice('SUBS.recipeone=', 'reg(\'rcpSearch\'');
  assert.match(sub, /cta:\(\)=>\{ const rec=state\.rcp\.rec;/);
  assert.match(sub, /ingredients\.length\)\|\|\(Array\.isArray\(rec\.steps\)&&rec\.steps\.length\)/);
});

check('the two composed pairs are declared', () => {
  assert.match(MHTML, /T\('Make it','开始制作'\)/);
  assert.match(MHTML, /T\('Start the steps','开始步骤'\)/);
});

console.log('\n' + (failures ? `✗ ${failures} failed` : 'All assertions held.'));
process.exit(failures ? 1 : 0);
