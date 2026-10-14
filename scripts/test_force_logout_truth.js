#!/usr/bin/env node
/**
 * "Sign out all devices" tells the truth — the control, its count, and its copy.
 *
 * Reported from the shop: an operator opened a customer, hit More ▾ → Sign out
 * all devices, and said it "seems not working — I can still see all my address
 * there and my name". Three separate things were true at once, and only one of
 * them was the operator misreading the screen.
 *
 *   1. NOT A BUG, and the copy never said so. The drawer shows the customer's
 *      DATABASE RECORD. Names and addresses live in retail_customers /
 *      retail_addresses and no sign-out touches them. The panel is identical
 *      before and after by design.
 *
 *   2. THE COUNT WAS WRONG. routes/retail.js compared retail_auth_tokens
 *      .expires_at — written as a raw .toISOString(), '2026-10-16T06:22:40.123Z'
 *      — against datetime('now'), which returns '2026-09-16 06:22:40'. As text
 *      those agree for ten characters and then hit 'T' (0x54) against ' '
 *      (0x20). 'T' sorts higher, so every token that expired earlier the SAME
 *      DAY counted as live. Only the count was affected: requireRetailAuth
 *      already wrapped the column, so a dead token was advertised, never
 *      honoured.
 *
 *   3. THE COPY PROMISED SOMETHING IT CANNOT DELIVER. It said the customer can
 *      sign back in normally. In the WeChat mini app she does not have to:
 *      miniapp/utils/api.js catches the 401 this revoke causes, runs a fresh
 *      silent wx.login and replays the request. No sign-in screen, nothing the
 *      customer can notice. On the web storefront there is no silent re-login
 *      and the sign-out is real. An operator reaching for this because a phone
 *      was stolen needs to know which they are getting — and that Block, which
 *      requireRetailAuth refuses even on a valid token, is the lock.
 *
 *   4. AND THE TOAST COULD NOT REPORT ANY OF IT. It was authored as an EN · CN
 *      pair with the count in the middle, so the bilingual walker (processNode
 *      in public/retail-admin/10-extras.js, which splits on the FIRST ' · ')
 *      cut it at the wrong place: English operators saw the label with NO
 *      NUMBER, Chinese ones saw the English half. The number was the only thing
 *      the toast existed to say, and 0 was the answer to "why did nothing
 *      change".
 *
 * STATIC, and a ban, for the reason the money suite gives: none of this is
 * wrong on a screen until somebody reaches for it in an emergency, which is
 * after it matters. Chinese strings are checked against
 * docs/tacet-delivery-vocabulary.md §152 because CLAUDE.md requires every
 * composed string to be declared, and an undeclared one is indistinguishable
 * from a locked one to whoever comes next.
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
const section = (t) => console.log('\n' + t);

// routes/retail.js and its parts: the customers area now lives in
// routes/retail/customers.js (decisions §470).
const RETAIL  = require('./test-support/retail-source').retailSource();
const DESKTOP = read('public/retail-admin/08-customers.js');
const PHONE   = read('public/m.html');
const VOCAB   = read('docs/tacet-delivery-vocabulary.md');

/* Pull one handler out by its opening and the thing that follows it. Slicing by
   line number would rot — CLAUDE.md's rule about line numbers being historical
   coordinates applies to a test as much as to a document. */
function bodyFrom(src, opener, closer) {
  const i = src.indexOf(opener);
  if (i === -1) return null;
  const j = src.indexOf(closer, i);
  if (j === -1) return null;
  return src.slice(i, j);
}

/* Comments stripped before any assertion about what the copy SAYS. Both
   handlers carry a note explaining the wording they replaced, and such a note
   has to quote the old wording to be worth anything — so an un-stripped slice
   reads as though the old claim were still shipping, and this suite would fail
   on its own documentation. Same strip the money suite uses, same reason: the
   subject here is the strings, and the strings are in the code. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

// ─────────────────────────────────────────────────────────────────────────
section('1 · the expiry comparison normalises the column, not just "now"');

/* The fact the old query got wrong, proven in plain JS so this suite explains
   itself without a database. If this ever stops holding, the rest of this
   section is arguing about nothing. */
yes('2026-09-16T05:00:00.000Z' > '2026-09-16 06:23:00',
  'a raw text compare really does read an expired ISO token as live',
  'if this fails the premise changed — re-read the queries before trusting this suite');

/* Every read of this column, everywhere in the routes, must wrap it. Grepped
   rather than asserted at one line: a finding filed as file:line is where it
   was found, not the extent of the problem. */
const rawTokenCompare = RETAIL.split('\n')
  .map((l, i) => ({ n: i + 1, l }))
  .filter(({ l }) => !/^\s*(\/\/|\*)/.test(l))
  .filter(({ l }) => /retail_auth_tokens/.test(l) || /\bt\.expires_at\b/.test(l))
  .filter(({ l }) => /(?<!datetime\()\b(?:t\.)?expires_at\s*[<>]/.test(l));

yes(rawTokenCompare.length === 0,
  'no retail_auth_tokens query compares expires_at without datetime()',
  rawTokenCompare.map((r) => `routes/retail.js:${r.n}  ${r.l.trim()}`).join('\n      '));

const countQ = RETAIL.slice(RETAIL.indexOf('SELECT COUNT(*) AS n FROM retail_auth_tokens'), RETAIL.indexOf('SELECT COUNT(*) AS n FROM retail_auth_tokens') + 200);
yes(/datetime\(expires_at\)\s*>\s*CURRENT_TIMESTAMP/.test(countQ),
  "the drawer's active-session count wraps the column", countQ.slice(0, 160));

/* The writer is why the column needs wrapping at all. If issueToken ever starts
   storing SQLite's own shape, this suite should be revisited rather than
   quietly keep passing on a wrap that has become decoration. */
yes(/const expiresAt = new Date\(Date\.now\(\) \+ TOKEN_TTL_MS\)\.toISOString\(\)/.test(RETAIL),
  'issueToken still writes a raw ISO string, so the wrap is still load-bearing');

// ─────────────────────────────────────────────────────────────────────────
section('2 · the desktop confirmation says what the control does');

const deskRaw = bodyFrom(DESKTOP, 'async function cuForceLogout(ev)', '\nfunction cuOpenAdjust');
const deskFn  = deskRaw ? strip(deskRaw) : null;
yes(deskFn, 'cuForceLogout is findable');

if (deskFn) {
  yes(/CU_CURRENT\.stats && CU_CURRENT\.stats\.active_sessions/.test(deskFn),
    'it reads the live session count before asking');
  yes(/Mini Program/.test(deskFn) && /automatically/.test(deskFn),
    'it admits the mini app signs them straight back in');
  yes(/Use Block to lock them out/.test(deskFn),
    'it names Block as the control that actually locks the account');
  yes(/No active sessions/.test(deskFn),
    'it says so when there is nothing to revoke, instead of promising a sign-out');
  yes(!/can sign back in normally/.test(deskFn), 'the old half-truth is gone');

  /* The walker trap. Every authored string in this handler goes through cuT,
     so no text node it produces can carry an ' · ' with Chinese on the right
     — which is the only shape processNode acts on. */
  const authored = [...deskFn.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map((m) => m[2]);
  const zh = (t) => /[一-鿿]/.test(t);
  const pairish = authored.filter((t) => {
    const i = t.indexOf(' · ');
    return i !== -1 && zh(t.slice(i + 3)) && !zh(t.slice(0, i));
  });
  yes(pairish.length === 0,
    'no string here is an EN · CN pair the walker would cut at the count',
    pairish.join('\n      '));

  const toastCall = bodyFrom(deskFn, 'toast(n', 'cuOpenDetail');
  yes(toastCall && /cuT\(/.test(toastCall) && /个会话/.test(toastCall),
    'the toast composes one language with cuT and can still carry the number');
  yes(toastCall && /未撤销任何内容/.test(toastCall),
    'and it reports the honest zero rather than saying nothing');
}

// ─────────────────────────────────────────────────────────────────────────
section('3 · the phone sheet says the same thing');

const phoneRaw = bodyFrom(PHONE, "reg('forceLogout'", '/* ── The three referral controls');
const phoneFn  = phoneRaw ? strip(phoneRaw) : null;
yes(phoneFn, "reg('forceLogout') is findable");

if (phoneFn) {
  yes(/Mini Program/.test(phoneFn) && /automatically/.test(phoneFn),
    'the phone admits the mini app signs them straight back in');
  yes(/Use Block to lock them out/.test(phoneFn), 'the phone names Block too');
  yes(/No active sessions/.test(phoneFn) && !/Any session they have is ended/.test(phoneFn),
    'the zero branch no longer promises to end sessions that do not exist');
  yes(!/will need to sign in again/.test(phoneFn),
    'the claim that is false in the mini app is gone from both branches');
}

// ─────────────────────────────────────────────────────────────────────────
section('4 · every Chinese string this control ships is declared');

/* CLAUDE.md, as amended 2026-09-06: composing is delegated, composing SILENTLY
   is not. Each sentence below is in the code; §152 is where it was declared. */
const DECLARED = [
  '退出所有设备？',
  '撤销可以清除泄露的令牌，但不能锁定账号。',
  '网页商店会立即退出；',
  '微信小程序会自动重新登录，不会出现登录页。',
  '当前没有活跃会话，无可撤销内容。',
  '当前没有活跃会话，未撤销任何内容',
  '如需锁定，请改用封禁。',
];

yes(/^## Signing a customer out says what it actually does/m.test(VOCAB),
  '§152 exists in docs/tacet-delivery-vocabulary.md');

for (const s of DECLARED) {
  yes((deskFn && deskFn.includes(s)) || (phoneFn && phoneFn.includes(s)), `shipped: ${s}`);
  yes(VOCAB.includes(s), `declared: ${s}`,
    'in the code and not in the vocabulary document — the undeclared string CLAUDE.md bans');
}

/* The direction that actually catches a future edit: not "are the seven strings
   I listed still there", but "is there any Chinese in these handlers the
   document has never seen". Interpolations collapse to N so a count placeholder
   matches the document's own N, and the text is cut on its sentence marks
   because the document declares sentences while the code ships paragraphs. */
const sentences = (src) => [...new Set(
  [...src.matchAll(/[一-鿿][^'"`]*/g)]
    .map((m) => m[0].replace(/\$\{[^}]*\}/g, 'N').replace(/'\s*\+\s*n\s*\+\s*'/g, 'N'))
    .flatMap((t) => t.split(/(?<=[。；])/))
    .map((t) => t.trim())
    .filter((t) => /[一-鿿]/.test(t)),
)];

for (const [where, src] of [['desktop', deskFn], ['phone', phoneFn]]) {
  const stray = sentences(src || '').filter((s) => !VOCAB.includes(s));
  yes(stray.length === 0,
    `no Chinese sentence in the ${where} handler is missing from the document`,
    stray.join('\n      '));
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
