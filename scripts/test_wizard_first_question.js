#!/usr/bin/env node
/**
 * test_wizard_first_question.js — a wizard opens on a question (audit F-02).
 *
 *   node scripts/test_wizard_first_question.js
 *
 * THE FINDING. Both wizards opened on a choose-your-route screen — three doors
 * for a product, five for a coupon — before anything was asked. For the common
 * case that is one click and a screen of reading spent on nothing.
 *
 * The fix is not "delete the doors": two of the product's three routes are
 * genuinely useful, and the coupon's five are real starting points. It is to
 * open on the first question with the other routes offered BESIDE it, where
 * they cost nothing to the people who do not want them.
 *
 * What has to stay true afterwards, and each of these is a way to get it wrong:
 *
 *   - The first step has no Back button, because there is nowhere behind it.
 *   - Closing an untouched wizard asks nothing. The "have you done any work"
 *     test used to key on the door step, which no longer exists — and a
 *     confirm dialog for opening and closing a wizard is worse than the click
 *     this removed.
 *   - The alternative routes are offered only while nothing has been typed.
 *     Both of them FILL BOXES IN, so offering them over half-finished work is
 *     offering to overwrite it.
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
const MKT  = fs.readFileSync(path.join(ROOT, 'public/retail-admin/05-marketing.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
const slice = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

// ── the product wizard ────────────────────────────────────────────────────
section('1 · adding a product starts by asking what it is');

yes(/step: 'what', source: 'scratch'/.test(PROD),
  'the wizard opens on the first question, already on the ordinary route');
no(/step: 'front'/.test(PROD), 'and the door screen it used to open on is gone');
no(/function pwFrontHtml/.test(PROD), 'along with the markup for it — not left behind unreachable');

yes(/pwFoot\(null, 'pwNextWhat\(\)', 'what'\)/.test(PROD),
  'the first step draws no Back button');
{
  const foot = slice(PROD, 'function pwFoot(', 'function pwRender(');
  yes(/backStep\s*\?/.test(foot) && /<span><\/span>/.test(foot),
    'it draws a spacer instead, so the dots stay put between step one and two');
}

section('2 · the other two ways in are beside the question, not before it');
{
  const alts = slice(PROD, 'function pwAltRoutesHtml(', 'function pwFront(');
  yes(/_pw\.source !== 'scratch'/.test(alts), 'they are offered only on the plain route');
  yes(/pwHasWork\(\)/.test(alts),
    'and only while nothing has been typed — both of them fill boxes in');
  // The handlers are built as strings, so the literal call never appears in the
  // source — what is asserted is that both routes are still named and still go
  // through pwFront.
  yes(/link\('paste'/.test(alts) && /link\('copy'/.test(alts) && /pwFront\(/.test(alts),
    'both routes are still reachable');
  yes(/return pwAltRoutesHtml\(\)/.test(PROD), 'and they are drawn above the first question');
  // Back from either route returns to the question, not to a screen that is
  // gone — which would have been a dead button.
  no(/pwGoto\('front'\)/.test(PROD), 'neither route has a Back pointing at the old door');
}

section('3 · opening and closing asks nothing');
{
  const work = slice(PROD, 'function pwHasWork(', 'async function pwTryClose(');
  yes(/_pw\.step !== 'what'/.test(work),
    'an untouched first question is not work in progress');
  no(/_pw\.step !== 'front'\b/.test(work.replace(/\/\/.*$/gm, '')),
    'and the old door step is not what that test keys on any more');
  yes(/name_en/.test(work) && /hasSizes/.test(work),
    'anything actually typed still counts, exactly as before');
}

// ── the coupon wizard ─────────────────────────────────────────────────────
section('4 · making a coupon starts by asking about the deal');

yes(/goal: 'public', step: 'deal'/.test(MKT),
  'the wizard opens on the first question with the plainest starting point in it');
no(/function vwFrontHtml/.test(MKT), 'the five-door screen is gone');
yes(/function vwGoalChipsHtml/.test(MKT), 'and the five are a row of chips instead');
yes(/return vwGoalChipsHtml\(\)/.test(MKT), 'drawn above the first question');
{
  const chips = slice(MKT, 'function vwGoalChipsHtml(', 'function vwDealHtml(');
  yes(/vwApplyGoal\(/.test(chips), 'each chip applies a goal');
  for (const g of ['welcome', 'sale', 'public', 'shipping', 'fresh']) {
    yes(new RegExp(`\\['${g}',`).test(chips), `${g} is still one of them`);
  }
  yes(/_vw\.goal === g\[0\]/.test(chips), 'and the one the answers came from is marked');
}
{
  const apply = slice(MKT, 'function vwApplyGoal(', '// ── navigation ──');
  yes(/_vw\.step === 'deal'/.test(apply) && /vwRender\(\)/.test(apply),
    'picking one on the first step re-renders in place rather than sliding to itself');
}
{
  const back = slice(MKT, 'function vwBack(', 'function vwBigValue(');
  no(/vwGoto\('front'\)/.test(back), 'Back on the first step does not go to a screen that is gone');
  const foot = slice(MKT, 'function vwFootHtml(', 'function vwSetType(');
  yes(/steps\.indexOf\(_vw\.step\) <= 0/.test(foot), 'and no Back button is drawn there at all');
}

section('5 · the chips are quiet, and styled');
{
  yes(/\.pw-alts, \.vw-alts/.test(HTML), 'both rows share one style');
  yes(/\.vw-alt\.on/.test(HTML), 'the coupon chips can show which one is current');
  // The review step keeps its own screen, deliberately. The audit noted it as
  // a second cost; a last look before something is created is worth one click,
  // and a Publish button under the last form field is where mistaken products
  // come from.
  yes(/pwFinish\(true\)/.test(PROD) && /vwSave\(true\)/.test(MKT),
    'creating still happens on a review step of its own, which is deliberate');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
