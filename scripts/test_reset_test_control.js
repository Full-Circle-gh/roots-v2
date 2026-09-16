#!/usr/bin/env node
/**
 * "Reset to a new customer" — the control, its gate, and the word it types.
 *
 * `POST /api/retail-admin/customers/:id/reset-test` had existed in the routes
 * with NO BUTTON ANYWHERE since it was written, marked TESTING ONLY in a
 * comment and nowhere a person could read it. It archives the customer's
 * openid by prefixing it, so their next silent wx.login cannot match it and
 * POST /api/retail/auth mints them a brand-new customer row. Their orders,
 * points, balance and addresses stay exactly where they are and their phone
 * can never reach any of it again. The row is NOT deleted — several child
 * tables are ON DELETE RESTRICT — which is why "reset" is the honest verb.
 *
 * Giving it a button changes what three pre-existing facts cost:
 *
 *   1. THE CAPABILITY. It matched none of the words in cap-routes' block rule,
 *      so it answered `customers:edit` — the weakest customer capability, the
 *      one most staff hold — for the most destructive route in the file. Free
 *      to narrow while nobody could reach it; not free afterwards. Moved
 *      first, and asserted in scripts/test_capability_gaps.js §5 as well as
 *      here, because that file is where "what capability does this route
 *      need" is answered.
 *
 *   2. THE TYPED GATE. askConfirm has documented a `matchWord` gate since it
 *      was written and NOTHING had ever passed one, so its label was still
 *      English-only — never printed at an operator reading Chinese, so never
 *      reported. This control is its first caller.
 *
 *   3. THE ERROR CODE. A second reset answers `already_reset`, which had no
 *      row in the admin's error table, so it would have surfaced as a bare
 *      code. Audit A-09 bans that.
 *
 * STATIC, and a ban. The cost of this control being wrong is a real customer
 * who cannot reach their own orders from their phone, and that is not a thing
 * a render test finds — it is a thing a missing `data-cap` or a softened
 * confirm causes six months from now.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0; let fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const section = (t) => console.log('\n' + t);

const DESKTOP = read('public/retail-admin/08-customers.js');
const CORE    = read('public/retail-admin/01-core.js');
const DIALOGS = read('public/tacet-dialogs.js');
const RETAIL  = read('routes/retail.js');
const VOCAB   = read('docs/tacet-delivery-vocabulary.md');

const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function bodyFrom(src, opener, closer) {
  const i = src.indexOf(opener);
  if (i === -1) return null;
  const j = src.indexOf(closer, i);
  if (j === -1) return null;
  return src.slice(i, j);
}

// ─────────────────────────────────────────────────────────────────────────
section('1 · the capability moved before the button shipped');

const { requiredCapFor } = require(path.join(ROOT, 'lib', 'cap-routes.js'));
is(requiredCapFor('POST', '/api/retail-admin/customers/12/reset-test'), 'customers:block',
  'the route demands customers:block');

/* The server side of the same fact: the route is still behind requireRetailAdmin
   and still refuses a second reset. If either goes, the UI's honesty about
   "already reset" is describing something that no longer happens. */
const routeFn = bodyFrom(RETAIL, "router.post('/api/retail-admin/customers/:id/reset-test'", '\n});');
yes(routeFn && /requireRetailAdmin/.test(routeFn), 'the endpoint is still admin-gated');
yes(routeFn && /already_reset/.test(routeFn), 'the endpoint still refuses a second reset');
yes(routeFn && /_reset_/.test(routeFn), 'it still archives the openid rather than deleting the row');
yes(routeFn && !/DELETE FROM retail_customers/.test(routeFn),
  'and it still never deletes the customer row',
  'the copy promises the record is kept — if that stops being true the copy is a lie');

// ─────────────────────────────────────────────────────────────────────────
section('2 · the control is gated, marked, and hard to hit by accident');

const handler = (() => {
  const raw = bodyFrom(DESKTOP, 'async function cuResetTestCustomer(ev)', '\nfunction cuOpenAdjust');
  return raw ? strip(raw) : null;
})();
yes(handler, 'cuResetTestCustomer is findable');

const menuItem = (() => {
  const raw = bodyFrom(DESKTOP, 'const resetItem = `', '`;');
  return raw || null;
})();
yes(menuItem, 'the menu item is findable');

if (menuItem) {
  yes(/data-cap="customers:block"/.test(menuItem),
    'the menu item carries data-cap so it is hidden from anyone who would be refused');
  yes(/class="cux-mi danger"/.test(menuItem), 'it renders brick, like the destructive action it is');
  yes(/cux-sep/.test(menuItem), 'it sits behind its own divider');
  yes(/alreadyReset \? 'disabled' : ''/.test(menuItem),
    'it goes dead rather than vanishing once it has been used');
}

/* A data-cap that nothing sweeps is a decoration. cuRenderDetail paints this
   drawer in JavaScript long after setCaps() ran its one pass, so unless the
   render calls applyCapGates itself, every [data-cap] in here — including the
   two customers:adjust buttons that predate this control — is inert. */
// Comments stripped, or this assertion passes on the note above the call
// explaining why the call is there — which is exactly how it first passed with
// the call deleted.
const render = (() => {
  const raw = bodyFrom(DESKTOP, 'function cuRenderDetail()', '\nfunction renderAffiliateBlock');
  return raw ? strip(raw) : null;
})();
yes(render && /applyCapGates\(\)/.test(render),
  'the drawer render runs the capability sweep, so data-cap actually hides things',
  'without this the attribute is decorative and the control is offered to operators the server refuses');
yes(render && render.lastIndexOf('applyCapGates()') > render.lastIndexOf(".innerHTML = `"),
  '…and runs it AFTER the markup is painted, not before');

if (handler) {
  yes(/matchWord: 'RESET'/.test(handler), 'it makes the operator type RESET');
  yes(/danger: true/.test(handler), 'the dialog is the danger variant');
  yes(/startsWith\('_reset_'\)/.test(handler),
    'it refuses a second reset in the client too, rather than relying on the round trip');
  yes(/not deleted/.test(handler) && /never reach it again/.test(handler),
    'the copy says the record survives AND that the phone cannot reach it');
  yes(/For testing signup on your own phone/.test(handler) && /Not for a real customer/.test(handler),
    'the copy says what it is for, and what it is not for');

  /* Same walker trap the sign-out control was fixed for: the title carries the
     customer's own NAME, which can be anything. Nothing here may be authored
     as an EN · CN pair. */
  const authored = [...handler.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map((m) => m[2]);
  const zh = (t) => /[一-鿿]/.test(t);
  const pairish = authored.filter((t) => {
    const i = t.indexOf(' · ');
    return i !== -1 && zh(t.slice(i + 3)) && !zh(t.slice(0, i));
  });
  yes(pairish.length === 0,
    'no string here is an EN · CN pair the walker would cut at the name or the count',
    pairish.join('\n      '));
}

// ─────────────────────────────────────────────────────────────────────────
section('3 · the typed gate prints in both languages');

const gate = bodyFrom(DIALOGS, 'const gateField = opts.matchWord', ': \'\';');
yes(gate, 'the gate field is findable');
if (gate) {
  yes(/输入 \$\{opts\.matchWord\} 以继续/.test(gate), 'the label has a Chinese half');
  yes(/Type \$\{opts\.matchWord\} to continue/.test(gate), '…and still has its English one');
  yes(/ · /.test(gate), '…joined by the separator the page walker splits on');
}

/* The constraint that pair creates, recorded where a future caller reads it. */
yes(/ASCII only and no ' · '/.test(DIALOGS),
  "the API header warns that matchWord must be ASCII",
  'the word is printed on BOTH sides of the label — a Chinese one breaks the split');

/* And the only caller so far honours it. */
if (handler) {
  const word = (handler.match(/matchWord: '([^']*)'/) || [])[1] || '';
  yes(/^[\x20-\x7E]+$/.test(word) && !word.includes(' · '),
    `the one caller's word (${word}) is ASCII and carries no separator`);
}

// ─────────────────────────────────────────────────────────────────────────
section('4 · a refused second reset reads as a sentence, not a code');

yes(/already_reset:\s*\[/.test(CORE), 'already_reset has a row in the admin error table');
const row = (CORE.match(/already_reset:\s*\[([^\]]*)\]/) || [])[1] || '';
yes(/[一-鿿]/.test(row) && /[A-Za-z]/.test(row), '…with both languages in it');
yes(!/already_reset/.test(row), '…and it does not just echo the code back');

// ─────────────────────────────────────────────────────────────────────────
section('5 · every Chinese string this control ships is declared');

const DECLARED = [
  '重置为新顾客',
  '将其微信登录与此记录解除关联。',
  '此记录会保留，不会删除，但其手机将无法再次访问。',
  '仅用于在自己手机上测试注册流程，请勿用于真实顾客。',
  '输入 ${opts.matchWord} 以继续',
  '该顾客已重置，正等待以新顾客身份进入。',
];

yes(/^## Reset to a new customer, and the word it makes you type/m.test(VOCAB),
  '§154 exists in docs/tacet-delivery-vocabulary.md');

for (const zhs of DECLARED) {
  const inCode = DESKTOP.includes(zhs) || DIALOGS.includes(zhs) || CORE.includes(zhs);
  yes(inCode, `shipped: ${zhs}`);
  const declared = VOCAB.includes(zhs.replace('${opts.matchWord}', 'RESET'));
  yes(declared, `declared: ${zhs}`,
    'in the code and not in the vocabulary document — the undeclared string CLAUDE.md bans');
}

/* The direction that catches a future edit: any Chinese sentence in the
   handler or the menu item the document has never seen. */
const sentences = (src) => [...new Set(
  // Stops at a newline as well as at a quote: the menu item is a multi-line
  // template, so a label on one line otherwise swallows the expression below it.
  [...src.matchAll(/[一-鿿][^'"`\n]*/g)]
    .map((m) => m[0].replace(/\$\{[^}]*\}/g, 'N'))
    .flatMap((t) => t.split(/(?<=[。；？])/))
    .map((t) => t.trim())
    .filter((t) => /[一-鿿]/.test(t)),
)];
/* Tags stripped first: the menu item is an HTML template, and splitting it
   on sentence marks otherwise hands the guard a fragment of markup to look
   up in a prose document. */
const stray = sentences(((handler || '') + (menuItem || '')).replace(/<[^>]*>/g, ' '))
  .filter((t) => !VOCAB.includes(t));
yes(stray.length === 0,
  'no Chinese sentence in the control is missing from the document',
  stray.join('\n      '));

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
