#!/usr/bin/env node
/**
 * test_wizard_required_pick.js — a pick-any question can be made required.
 *
 *   node scripts/test_wizard_required_pick.js
 *
 * THE FINDING, reported from a live QR menu. A Hummus Platter's picker asked
 * "Choose 2 crunchy sides" and the Add to basket button took the order with
 * nothing ticked. Nothing was broken in the picker: routes/shop-menu.js blocks
 * an unanswered required question and names it, public/shop.html does the same,
 * and the order route refuses it a second time on the server. The question was
 * simply not flagged required, and the shop owner had no way to flag it.
 *
 * WHY THERE WAS NO WAY. The product wizard draws two kinds of question — a
 * "free pick" (type single) and a "paid extra" (type multi) — and drew the
 * Required tick on the free one only. Product-Wizard-v1-Spec.md put it there on
 * purpose: a paid extra is an upsell, and forcing one is a surcharge. That
 * reading is right about upsells and wrong about the menus this shop runs. A
 * question with several FREE answers — every delta zero, "choose 2 crunchy
 * sides" — has to be a multi, because a free pick is always a single. So the
 * one question shape that most needed the tick was the one shape that could
 * never have it.
 *
 * The full product editor has shown Required on every type all along, and
 * pwSave writes is_required through whatever the type. So this was also two
 * editors disagreeing about one saved field: a required multi set in the full
 * editor reopened in the wizard with its tick nowhere on screen.
 *
 * What has to stay true afterwards, and each of these is a way to get it wrong:
 *
 *   - The tick is drawn on BOTH kinds of question, not gated on the type.
 *   - It is still a decision, not a default: a newly added question of either
 *     kind starts unticked. Ticking boxes for the shop owner is how a product
 *     goes live refusing orders nobody meant to refuse.
 *   - The save path carries is_required for both types, or the tick is theatre.
 *   - No new string was composed for it — CLAUDE.md's Chinese rule. The label
 *     is the pair that was already on the free pick.
 *   - The three places that ENFORCE required still enforce it. A tick that
 *     nothing reads is worse than no tick.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const no  = (c, m, extra) => (!c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const PROD = fs.readFileSync(path.join(ROOT, 'public/retail-admin/09-products.js'), 'utf8');
const MENU = fs.readFileSync(path.join(ROOT, 'routes/shop-menu.js'), 'utf8');
const SHOP = fs.readFileSync(path.join(ROOT, 'public/shop.html'), 'utf8');
// §182 moved the server-side answer check out of routes/shop-menu.js and into a
// module the counter till obeys too. The rule did not change and nothing about
// this suite's claim changed; only where the rule is written did.
const OPTS = fs.readFileSync(path.join(ROOT, 'lib/product-options.js'), 'utf8');

// The slice is taken by name rather than by line number: CLAUDE.md's citation
// rule — a line number in this file would drift and quietly stop asserting.
const slice = (src, from, to) => {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`test is stale: "${from}" is no longer in the source`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`test is stale: "${to}" is no longer after "${from}"`);
  return src.slice(a, b);
};

// ── the wizard draws it on both ───────────────────────────────────────────
section('1 · the wizard offers Required on a pick-any question too');
{
  const block = slice(PROD, 'function pwOptBlock(', 'function pwChoiceRow(');

  yes(/pwOptReq\(/.test(block),
    'the question block still draws the Required tick');

  no(/const req = paid \?/.test(block),
    'and it is no longer withheld from the paid/pick-any half',
    'a free pick is always a single, so a multi is the only way to ask a\n' +
    '      question with several free answers — gating the tick on `paid`\n' +
    '      makes "Choose 2 crunchy sides" impossible to require');

  // The assertion that survives a rewrite of the ternary into an if, a helper,
  // or a template literal: whatever shape it takes, the type must not reach it.
  const reqLine = (block.match(/^.*pwOptReq\(.*$/m) || [''])[0];
  no(/\bpaid\b/.test(reqLine), 'the tick is built without consulting the type at all',
    reqLine.trim().slice(0, 120));

  yes(/They have to pick one before they can buy/.test(block)
    && /购买前必须选择/.test(block),
    'on the live English/中文 pair it already used — nothing composed');
}

// ── still a decision, not a default ───────────────────────────────────────
section('2 · a new question of either kind starts unticked');
{
  const free = slice(PROD, 'function pwAddFree(', 'function pwAddPaid(');
  const paid = slice(PROD, 'function pwAddPaid(', 'function pwOptRemove(');

  yes(/is_required: 0/.test(free), 'a new free pick is not required until somebody says so');
  yes(/is_required: 0/.test(paid), 'and neither is a new paid extra');

  const setter = slice(PROD, 'function pwOptReq(', 'function pwOptC(');
  yes(/is_required = on \? 1 : 0/.test(setter),
    'the tick writes 1 or 0, so a half-set value never reaches the save');
}

// ── the save carries it ───────────────────────────────────────────────────
section('3 · is_required survives the save for both types');
{
  // pwSave builds each option row; the field must not be gated on the type
  // there either, or the tick would clear itself on the way out.
  const save = slice(PROD, 'function pwOptionsBody(', 'async function pwPrimaryStore(');
  yes(/is_required: o\.is_required \? 1 : 0/.test(save),
    'the payload writes is_required off the question, whatever its type');
  no(/type === 'multi'[^\n]*is_required/.test(save),
    'and does not strip it from a pick-any on the way to the server');
}

// ── the full editor still agrees ──────────────────────────────────────────
section('4 · the full product editor still shows it on every type');
{
  yes(/class="opt-req"/.test(PROD) && /optReq\(/.test(PROD),
    'the full editor keeps its own Required tick');
  const optReqLine = (PROD.match(/^.*class="opt-req".*$/m) || [''])[0];
  no(/multi|single|o\.type/.test(optReqLine),
    'drawn for every type, which is the agreement the wizard now joins');
}

// ── and something still enforces it ───────────────────────────────────────
section('5 · a ticked box is read in all three places that matter');
{
  yes(/pkMissing\s*=\s*function/.test(MENU) && /if\(!g\.req\)continue/.test(MENU),
    'the QR menu finds the first required question with nothing live ticked');
  yes(/L_PICK_EN\+miss\.q_en/.test(MENU),
    'and refuses Add to basket naming that question');
  // THE RULE IS IN THE MODULE AND THE ROUTE CALLS IT — §182. Both halves are
  // asserted, because either alone would pass a refactor that broke the other:
  // a rule nobody calls enforces nothing, and a call into a module that no
  // longer carries the rule enforces nothing either.
  yes(/q\.is_required && !answered\.has\(q\.id\)/.test(OPTS)
    && /choice_required/.test(OPTS),
    'the shared module refuses it on the server, so the block is not cosmetic');
  yes(/productOptions\.resolveAnswers\(/.test(MENU),
    'and the QR order route actually calls it');
  // And so does the counter till, which is the whole of why the rule moved.
  const RETAIL = fs.readFileSync(path.join(ROOT, 'routes/retail.js'), 'utf8');
  yes(/productOptions\.resolveAnswers\(/.test(RETAIL),
    'and so does the counter till, on the same copy of the rule');
  // §152 gave a pick-any group a floor (min_choices), so this block now reads
  // "required with nothing ticked, OR fewer than the floor". The claim is
  // unchanged and the check is deliberately NOT pinned to the whole expression
  // again — a literal is what made this assertion go red for a correct change.
  yes(/o\.is_required\s*&&\s*!n/.test(SHOP) && /selIds\(o\)\.length/.test(SHOP),
    'and the web storefront refuses it the same way');
  yes(/l\.min\s*&&\s*n\s*<\s*l\.min/.test(SHOP),
    'and now also refuses a group answered fewer times than its floor (§152)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
