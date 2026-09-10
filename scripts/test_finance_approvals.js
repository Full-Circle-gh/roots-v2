#!/usr/bin/env node
/**
 * Offline self-test for the approval queue on the DESKTOP admin — Finance's
 * fourth sub-view (§87 step three).
 *
 *   node scripts/test_finance_approvals.js
 *
 * No network and no browser. Three parts:
 *
 *   1 · THE SURFACE, asserted against the shipped markup: that the sub-view
 *       exists beside Transactions, that it is gated on the same key the route
 *       requires, that both dots are wired, and that the controls belonging to
 *       other sub-views leave when this one arrives.
 *
 *   2 · NOT ONE STRING ON IT IS COMPOSED. This is the part worth having. The
 *       screen is a PORT of the phone's approvals screen, and the Rule 4
 *       amendment's first preference is to copy a live pair — so every Chinese
 *       half it renders must already exist somewhere else in the tree. A later
 *       edit that mints a new pair here fails this test by construction, which
 *       is the only way an undeclared string gets caught: it is indistinguishable
 *       from a locked one once it ships.
 *
 *   3 · THE DECISIONS a later edit could quietly undo, and each of them cost
 *       something to arrive at: exact money rather than the staircase's rounded
 *       figure, a number and nothing else through the settle markup, a poller
 *       that stops itself, and a decision that drops the two caches it just
 *       invalidated.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CLIENT = read('public', 'retail-admin', '22-finance.js');
const HTML = read('public', 'retail-admin.html');
const CSS = read('public', 'retail-admin.css');
const ROUTE = read('routes', 'staff-expenses.js');
const PHONE = read('public', 'm.html');

/* Comments stripped before any "must not" assertion — the house technique, and
   necessary here for the same reason as everywhere else in this directory: this
   file documents at length what it deliberately does not do, and every such
   sentence names the thing it is refusing. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/([^:'"`\\])\/\/.*$/gm, '$1');
}
const CLIENT_CODE = codeOnly(CLIENT);

// The pane's own source, sliced off at its banner. Assertions about what the
// approvals screen does must not be satisfied by something Transactions happens
// to do three hundred lines above it.
const APR_AT = CLIENT.indexOf('APPROVALS (§87 step three), ON THE DESKTOP');
const APR = APR_AT >= 0 ? CLIENT.slice(APR_AT) : '';
const APR_CODE = codeOnly(APR);

console.log('\n1 · the surface');

it('the sub-view exists, beside Transactions and before Categories', () => {
  assert.ok(APR_AT >= 0, 'the approvals section must be in 22-finance.js');
  assert.match(HTML, /data-sub="approvals"/);
  assert.match(HTML, /id="fin-apr"/);
  assert.match(HTML, /id="fin-apr-list"/);
  const tx = HTML.indexOf('data-sub="transactions"');
  const apr = HTML.indexOf('data-sub="approvals"');
  const cats = HTML.indexOf('data-sub="categories"');
  assert.ok(tx < apr && apr < cats,
    'Approvals sits between Transactions and Categories — it is the other end of the ledger');
});

it('the sub-view is gated on the SAME key the route refuses without', () => {
  // A view gate that names a different key from the server's is worse than no
  // gate: the button appears, the click 403s, and the operator is told the app
  // is broken rather than that they may not do this.
  assert.match(HTML, /data-sub="approvals"[\s\S]{0,120}data-cap="expenses:approve"/);
  assert.match(ROUTE, /req\.caps\.has\('expenses:approve'\)/);
});

it('both dots are wired — the rail row and the sub-view', () => {
  // A dot on the sub-view alone is invisible to everybody not already looking at
  // Finance, which is precisely the audience it exists to summon.
  assert.match(HTML, /id="financeTabBadge"/);
  assert.match(HTML, /id="fin-apr-dot"/);
  assert.match(HTML, /data-tab="finance"[\s\S]{0,400}id="financeTabBadge"/);
  assert.match(APR_CODE, /getElementById\('financeTabBadge'\)/);
  assert.match(APR_CODE, /getElementById\('fin-apr-dot'\)/);
});

it('the dot counts what the SERVER says is waiting', () => {
  // Not a client-side filter over a list that is capped at 200 rows. The route
  // computes `waiting` over the queue it sends; a screen that recounted could
  // disagree with the badge that summoned it.
  assert.match(ROUTE, /waiting: rows\.filter\(r => r\.status === 'submitted'\)\.length/);
  assert.match(APR_CODE, /finAprPaintDot\(\s*(FIN_APR\.waiting|\(j\.data && j\.data\.waiting\))/);
});

it('the dot is calm amber and does not pulse', () => {
  // §1.10 — colour encodes state, and a claim waiting on you is attention, not
  // an error. The rail already makes this correction for itself; the sub-view
  // strip is a second home for .tab-badge and needs its own.
  assert.match(CSS, /\.fin-subviews \.tab-badge \{[^}]*var\(--td-amber\)/);
  assert.match(CSS, /\.fin-subviews \.tab-badge \{[^}]*animation: none/);
});

it('the range bar and the CTA leave when the queue arrives', () => {
  // A "30 days" bar over a queue would suggest there are older claims it is
  // holding back; the server sends the queue whole. The CTA belongs to
  // Transactions — this screen types nothing.
  assert.match(CLIENT_CODE, /const isApr = which === 'approvals';/);
  assert.match(CLIENT_CODE, /if \(bar\) bar\.hidden = [^;]*\bisApr\b[^;]*;/);
  assert.match(CLIENT_CODE, /if \(cta\) cta\.hidden = !isTx;/);
});

it('the range ECHO leaves with the bar, not after it', () => {
  // The bar was hidden here from the day this pane shipped and the echo was
  // not, so the queue sat under `Aug 12 – Sep 10 · 30 days` in the page head —
  // the exact claim hiding the bar was meant to prevent, now unanswerable
  // because the control that would change it is gone. Asserted separately from
  // the bar: they are two elements saying one thing, and the failure was
  // shipping half the rule.
  assert.match(CLIENT_CODE, /if \(echo\) echo\.hidden = [^;]*\bisApr\b[^;]*;/);
  assert.match(CLIENT_CODE, /if \(echo\) echo\.hidden = [^;]*\bisCats\b[^;]*;/);
});

it('the three blocks are DIVs — §1.22, the rule that has bitten four times', () => {
  /* `section { display: none }` runs the tab system and is unscoped, so it
     matches a <section> at any depth. All three blocks shipped as <section>s
     and the whole sub-view rendered into the DOM with no box: correct HTML,
     correct data, no pixels. The rule's own history is why this is asserted
     rather than trusted — it had three documented bites and a correctly-worded
     convention before it took this one. */
  assert.doesNotMatch(APR_CODE, /<section/,
    'a content block inside retail-admin is a <div>; <section> means "a tab page"');
  assert.match(APR_CODE, /<div class="fin-apr-queue"/);
  assert.match(APR_CODE, /<div class="fin-apr-owed"/);
  assert.match(APR_CODE, /<div class="fin-apr-done"/);
  // And the forbidden remedy must not come back in its place (§1.22: "change
  // the tag, do not add a display override" — the block moves, never the rule).
  const blocks = CSS.slice(CSS.indexOf('#tab-finance .fin-apr-owed,'));
  assert.doesNotMatch(blocks.slice(0, 200), /display:\s*block/,
    'the blocks are divs now — a display override here re-arms the trap');
});

it('the column band obeys §1.13a and §1.6 — Ink on --td-header, sentence case', () => {
  /* Two drifts, one rule. The band read --td-raised, which is the surface the
     card already sits on, so it stopped reading as a header — --td-header
     exists because that comparison was made and rejected. And `text-transform`
     has to be declared: the global `th` rule sets uppercase, specificity is
     compared per property, and a property this rule never mentions has exactly
     one candidate in the cascade. DATE / ASKED BY / AMOUNT shipped against
     §1.6 while every value the rule did declare was correct. */
  const band = CSS.slice(CSS.indexOf('#tab-finance .fin-tx-table thead th {'));
  const decl = band.slice(0, 320);
  assert.match(decl, /background: var\(--td-header\)/);
  assert.doesNotMatch(decl, /background: var\(--td-raised\)/);
  assert.match(decl, /text-transform: none/);
  assert.match(decl, /position: sticky/);
});

it('Approve is Ink, and Finance keeps its one Dusk for the header CTA', () => {
  // §1.8: one Dusk CTA per page, and this button repeats per row — but the
  // half that decides it is rule 5's axis. Dusk means "tacet did this for
  // you"; an approver deciding a claim is the OPERATOR acting, the same as a
  // modal confirm. The button must not carry .fin-cta (Finance's Dusk fill),
  // and its own class must paint the house Ink primary.
  assert.doesNotMatch(APR_CODE, /class="fin-cta fin-apr-yes"/,
    'Approve must not wear .fin-cta — that is Finance\'s Dusk element');
  assert.match(APR_CODE, /class="fin-apr-yes"/);
  const yes = CSS.slice(CSS.indexOf('#tab-finance .fin-apr-yes {'));
  assert.match(yes.slice(0, 240), /background: var\(--td-text\)/,
    'Approve fills with Ink (--td-text), the house Ink primary');
  assert.doesNotMatch(yes.slice(0, 240), /--td-dusk/);
});

it('Summary is not left showing underneath the fourth pane', () => {
  // The bug every added pane re-introduces if the flags are written as negations.
  assert.match(CLIENT_CODE, /stair\.hidden = isTx \|\| isCats \|\| isApr/);
  assert.match(CLIENT_CODE, /if \(apr\) apr\.hidden = !isApr;/);
});

console.log('\n2 · not one string on it is composed');

/* Every cuT('…','…') the approvals section renders. The Chinese half of each
   must already live somewhere else in the tree — the phone, another admin
   bundle, or the vocabulary. */
function pairsIn(src) {
  const out = [];
  const re = /cuT\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.push({ en: m[1], cn: m[2] });
  return out;
}
/* OVER THE COMMENT-STRIPPED SOURCE, and that is not a detail. The section
   argues in prose about the pairs it rejected — `cuT('3 claims', '3 笔')` appears
   in a comment explaining why the numeral sits OUTSIDE the pair — and an
   extractor reading raw source indicts the code for the example that justifies
   it. Same reason test_finance_categories keeps 房租 in the comment it
   illustrates while the shipped word is 租金. */
const PAIRS = pairsIn(APR_CODE);

// Where a live pair may already exist. The approvals section itself is cut out
// of the admin haystack, so a string cannot vouch for itself.
const ADMIN_ELSEWHERE = CLIENT.slice(0, APR_AT) + HTML
  + fs.readdirSync(path.join(ROOT, 'public', 'retail-admin'))
      .filter(f => f.endsWith('.js') && f !== '22-finance.js')
      .map(f => read('public', 'retail-admin', f)).join('\n');
const VOCAB = read('docs', 'tacet-delivery-vocabulary.md');
const HAYSTACK = PHONE + '\n' + ADMIN_ELSEWHERE + '\n' + VOCAB;

it('the screen renders a real set of pairs (the extractor is not silently empty)', () => {
  // Without this, every assertion below passes on a regex that matched nothing.
  assert.ok(PAIRS.length >= 20, `expected the queue to render 20+ pairs, found ${PAIRS.length}`);
});

it('every Chinese half is a LIVE pair, copied and not composed', () => {
  // CLAUDE.md, Rule 4 as amended 2026-09-06: work the preferences in order —
  // copy a live pair FIRST. A string that fails here is not necessarily wrong,
  // but it is undeclared, and an undeclared string is indistinguishable from a
  // locked one to everyone who comes after. Declare it in
  // docs/tacet-delivery-vocabulary.md, marked composed and by whom, and it
  // passes — the point is that the choice is visible, not that it is forbidden.
  const undeclared = PAIRS
    .filter(p => /[⺀-鿿　-〿豈-￯]/.test(p.cn))
    .filter(p => !HAYSTACK.includes(p.cn))
    .map(p => `${p.en} · ${p.cn}`);
  assert.deepStrictEqual(undeclared, [],
    'composed and not declared — copy a live pair or declare these in the vocabulary');
});

it('every pair is bilingual — no English left standing in the Chinese half', () => {
  for (const p of PAIRS) {
    assert.ok(p.en.trim(), `an empty English half: ${JSON.stringify(p)}`);
    assert.ok(p.cn.trim(), `an empty Chinese half: ${JSON.stringify(p)}`);
    assert.notStrictEqual(p.cn, p.en, `untranslated pair: ${p.en}`);
  }
});

it('the three sentences that keep the buttons honest are all present', () => {
  // Vocabulary v1.48 locks them as a SET OF THREE written to be read together:
  // nothing is in the books until approval; approving records it; and paying it
  // back changes nothing, because it was already recorded. Two of the three
  // belong to this screen, and the third is on the phone under Submit.
  assert.ok(APR.includes('审批通过后即记入本月账目。'), 'approving records it');
  assert.ok(APR.includes('标记已付不会改动账目 — 该费用在审批通过时已记入。'),
    'and paying it back changes nothing');
  assert.ok(PHONE.includes('审批通过后才会记入账目。'), 'the first of the set, on the phone');
});

console.log('\n3 · the decisions');

it('a claim amount is EXACT — never the staircase\'s rounded figure', () => {
  // finMoney rounds to whole units, which is right for a ¥180,332 headline and
  // wrong on a row asking to approve ¥38.50. The screen must not reach for it.
  assert.match(APR_CODE, /function finAprMoney/);
  assert.match(APR_CODE, /acMoney/);
  assert.ok(!/finMoney\(/.test(APR_CODE),
    'the approval queue must not render a claim through the rounded formatter');
});

it('only a NUMBER travels through the settle markup', () => {
  // A name is free text out of tenant_users, and an onclick attribute decodes
  // twice — HTML entities, then the JS string literal — so an apostrophe in
  // O'Brien ends the argument early and a quiet syntax error eats the click.
  assert.match(APR_CODE, /onclick="finAprSettle\(\$\{i\}\)"/);
  assert.ok(!/finAprSettle\(\$\{JSON\.stringify/.test(APR_CODE),
    'a name must not be pushed through the markup');
  // And the handler looks the row up out of the payload the screen already holds.
  assert.match(APR_CODE, /const o = \(FIN_APR && FIN_APR\.owed \|\| \[\]\)\[Number\(idx\)\]/);
});

it('the settle writes are sequential, not raced', () => {
  // Four writes racing on one connection is how a settle ends with two applied.
  assert.match(APR_CODE, /for \(const claim of list\) \{[\s\S]{0,200}await api\(/);
});

it('a decision drops the two caches it just invalidated', () => {
  // Approving writes expense_entries — which is exactly what Transactions lists
  // and what the Summary staircase totals. Leaving them cached shows an operator
  // a total that does not include the ¥38 they just approved.
  assert.match(APR_CODE, /FIN_TX = null; FIN_TX_SEEN = false;/);
  assert.match(APR_CODE, /FIN_DATA = null;/);
});

it('the dot poller stops itself on a 403 and never asks again', () => {
  // can() FAILS OPEN (CAPS === null ⇒ true), so the capability check alone would
  // still fire this for every operator during the window before /me lands — a
  // 403 every fifteen seconds, forever, for a dot they can never be shown.
  assert.match(APR_CODE, /FIN_APR_POLL_OFF/);
  assert.match(APR_CODE, /e\.status === 403/);
  assert.match(APR_CODE, /if \(FIN_APR_POLL_OFF \|\| document\.hidden\) return;/);
});

it('a dropped packet does not report the queue empty', () => {
  // Only a 403 clears the dot. Any other failure — offline, a 500 — must leave
  // the badge exactly as it was, or a bad wifi moment says nothing is waiting.
  const cat = APR_CODE.slice(APR_CODE.indexOf('async function finAprPollDot'));
  const body = cat.slice(0, cat.indexOf('\n}'));
  const zero = (body.match(/finAprPaintDot\(0\)/g) || []).length;
  assert.strictEqual(zero, 1, 'the badge is cleared in exactly one place — the 403 branch');
  assert.match(body, /403[\s\S]{0,160}finAprPaintDot\(0\)/);
});

it('the poller does not act at load outside a browser', () => {
  // Three suites load this file into a bare vm context to exercise its renderers
  // against the locked pairs, and that context has no timers at all. An
  // unguarded setTimeout here took all three down at REQUIRE time.
  assert.match(APR_CODE, /typeof window === 'undefined' \|\| typeof document === 'undefined'/);
  assert.match(APR_CODE, /typeof setTimeout !== 'function'/);
});

it('a receipt that cannot be read SAYS so', () => {
  // The phone swallows this error and paints nothing, which is why nobody
  // noticed that /staff-expenses/:id/receipt scopes to submitted_by and
  // therefore serves an approver nothing for anybody else's claim.
  assert.match(APR_CODE, /无法读取该照片。/);
  assert.match(ROUTE, /WHERE id = \? AND submitted_by IS \?/,
    'when this route is widened, the sentence above stops firing on its own');
});

it('self-approval is marked, and the SERVER is what marks it', () => {
  // §87 part five: an approver may approve their own claim and the record is the
  // guard. The phone's first attempt read this off a client-held identity that
  // carries a name and a role and no id, so the marker silently never appeared.
  assert.match(APR_CODE, /r\.mine/);
  assert.match(ROUTE, /mine: r\.submitted_by != null && r\.submitted_by === \(req\.user\?\.id \|\| null\)/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
