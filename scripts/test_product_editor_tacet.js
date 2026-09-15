// The product page editor wears Tacet — and the phone preview inside it does NOT.
//
// WHY THIS FILE EXISTS. public/product-editor.html carried its own palette
// (Ink Charcoal, Tea Green, Aged Brass, IBM Plex) from before the product had a
// design system, and was the last large surface still wearing it. It now
// declares the SAME --td-* layer public/retail-admin.css does. That makes it a
// SECOND IMPLEMENTATION OF ONE CONTRACT — the same shape as
// lib/product-blocks-read.js against the mini app's component — and nothing but
// a test notices when one of the two moves.
//
// THE PREVIEW IS THE POINT OF THE SECOND HALF. The phone in the middle of the
// editor renders the CUSTOMER'S product page in the CUSTOMER'S brand: lime,
// forest, olive, oat. Tacet is the chrome around it, never a coat of paint over
// it. A session restyling the chrome and reaching one rule too far would repaint
// the thing the office is here to look at, and the office would be approving a
// page that does not exist. The .pa-prev-* rules are therefore fenced off, by
// test, from every Tacet token.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const EDITOR = fs.readFileSync(path.join(ROOT, 'public/product-editor.html'), 'utf8');
const ADMIN  = fs.readFileSync(path.join(ROOT, 'public/retail-admin.css'), 'utf8');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
// The page's single inline stylesheet. '' when there is none, so a caller that
// finds no rules fails on the assertion it meant to make rather than on a throw.
function styleOf(text) {
  const m = text.match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : '';
}
// Every top-level { } block that declares at least one --td-* custom property,
// keyed by its selector. Comments are stripped first: the token block in
// retail-admin.css carries the hierarchy rule as prose between declarations.
function tokenBlocks(text) {
  const out = {};
  const re = /(?:^|\n)[ \t]*([^\n{}][^\n{}]*?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(text)))) {
    const sel = m[1].trim();
    const decls = {};
    const dre = /(--td-[a-z0-9-]+)\s*:\s*([^;]+);/g;
    let d;
    while ((d = dre.exec(m[2]))) decls[d[1]] = d[2].trim();
    if (Object.keys(decls).length) out[sel] = Object.assign(out[sel] || {}, decls);
  }
  return out;
}

// Only the rules that style the editor's own chrome. .pa-prev-* is the customer's
// page and answers to the brand, not to this rulebook.
function chromeRules(text) {
  const css = styleOf(text);
  const out = [];
  const re = /(?:^|\n)[ \t]*([^\n{}][^\n{}]*?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(css)))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@') || /\.pa-prev/.test(sel)) continue;
    out.push({ sel, body: m[2] });
  }
  return out;
}

const EDITOR_TOKENS = tokenBlocks(EDITOR);
const ADMIN_TOKENS  = tokenBlocks(ADMIN);
const CHROME = chromeRules(EDITOR);

section('One Tacet layer, declared in two files');
check('the editor declares the --td-* tokens at all', () => {
  assert.ok(Object.keys(EDITOR_TOKENS).length >= 2,
    'the editor no longer declares a Tacet token block — it has been restyled away');
  assert.ok(EDITOR_TOKENS[':root'] && EDITOR_TOKENS[':root'][ '--td-surface' ],
    'the dark (default) token block is gone');
  assert.ok(EDITOR_TOKENS[':root[data-theme="light"]'],
    'the light token block is gone');
});
check('EVERY token it declares matches retail-admin.css, value for value', () => {
  const drift = [];
  for (const sel of Object.keys(EDITOR_TOKENS)) {
    const theirs = ADMIN_TOKENS[sel] || {};
    for (const k of Object.keys(EDITOR_TOKENS[sel])) {
      if (!(k in theirs)) drift.push(`${sel} { ${k} } exists only in the editor`);
      else if (theirs[k] !== EDITOR_TOKENS[sel][k]) {
        drift.push(`${sel} { ${k} }: retail-admin.css says ${theirs[k]}, the editor says ${EDITOR_TOKENS[sel][k]}`);
      }
    }
  }
  assert.deepStrictEqual(drift, [],
    'the two Tacet layers have drifted:\n      ' + drift.join('\n      '));
});
check('...and it covers the tokens the chrome actually uses', () => {
  for (const t of ['--td-surface', '--td-raised', '--td-border', '--td-text', '--td-text2',
                   '--td-paper', '--td-dusk', '--td-sage-ink', '--td-amber', '--td-brick']) {
    assert.ok(EDITOR_TOKENS[':root'][t], `${t} is referenced by the chrome but never declared`);
  }
});

section('The chrome obeys the rulebook');
check('NO UPPERCASE ANYWHERE — §1.6', () => {
  const shouting = CHROME.filter(r => /text-transform:\s*uppercase/.test(r.body)).map(r => r.sel);
  assert.deepStrictEqual(shouting, [],
    'these chrome rules still shout: ' + shouting.join(', '));
});
check('Inter 400/500 only — "nothing heavier, bold reads as shouting"', () => {
  const heavy = CHROME.filter(r => /font-weight:\s*(?:[6-9]00|bold)/.test(r.body)).map(r => r.sel);
  assert.deepStrictEqual(heavy, [],
    'these chrome rules set a weight above 500: ' + heavy.join(', '));
});
check('no gradients — "no layered shadows, no glassmorphism, no gradients anywhere"', () => {
  /* Three exceptions, all DRAWN rather than decorative — a gradient that is a
     picture of something, not a surface pretending to have depth:
       .pa-preset-thumb::after  a fade over a template thumbnail, and the
                               thumbnail is a picture of the CUSTOMER'S page;
       .cs-sw-none              the "no colour" swatch — a diagonal slash over a
                               checkerboard, which is how every colour picker
                               ever built has drawn absence. Replacing it with a
                               flat fill would make "none" look like a colour. */
  const allowed = /pa-preset-thumb|cs-sw-none/;
  const gradients = CHROME.filter(r => /gradient\(/.test(r.body) && !allowed.test(r.sel)).map(r => r.sel);
  assert.deepStrictEqual(gradients, [],
    'these chrome rules paint a gradient: ' + gradients.join(', '));
});
check('THE DUSK RULE — Dusk is the AI’s colour and is scarce by design', () => {
  /* "One Dusk element per screen is the norm; two is the maximum." On this
     screen the one is Smart paste, the only control that hands work to the
     model. A focus ring is exempt by name in retail-admin.css and does not
     count, so the ring and its tint are excluded here rather than argued about
     later. If this fails, something that is NOT the AI has taken the AI's
     colour. */
  const duskies = CHROME.filter(r => /var\(--td-dusk\b|var\(--td-dusk-hi\)/.test(r.body))
    // Declaring the token is not spending it: :root maps --ring onto Dusk, and
    // a ring is exempt by name in retail-admin.css ("a focus ring makes no
    // claim; it is the browser showing where the keyboard is").
    .filter(r => !/^:root/.test(r.sel))
    .filter(r => !/:focus|:focus-within/.test(r.sel))
    .map(r => r.sel);
  const elements = new Set(duskies.map(s => s.split(/[:\s]/)[0]));
  assert.ok(elements.size <= 2,
    `${elements.size} chrome elements carry Dusk (max 2): ${[...elements].join(', ')}`);
  assert.ok([...elements].every(s => /smart/.test(s)),
    'Dusk is on something that is not the AI action: ' + [...elements].join(', '));
});

section('The customer’s page is not repainted by the chrome');
check('NOT ONE .pa-prev-* RULE REFERENCES A TACET TOKEN', () => {
  const css = stripComments(styleOf(EDITOR));
  const offenders = [];
  const re = /(?:^|\n)[ \t]*([^\n{}][^\n{}]*?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (!/\.pa-prev/.test(m[1])) continue;
    if (/var\(--td-/.test(m[2])) offenders.push(m[1].trim());
  }
  assert.deepStrictEqual(offenders, [],
    'the chrome has reached into the preview: ' + offenders.join(', '));
});
check('the brand palette is still written into the preview, literally', () => {
  // A spot check on three of the brand's own values. If these have gone, the
  // preview has been "tidied" onto tokens and stopped being the brand.
  for (const hex of ['#CCD900', '#365329', '#F2E7DF']) {
    assert.ok(EDITOR.includes(hex), `the brand colour ${hex} is no longer in the file`);
  }
});

section('The chrome is not carrying the old palette any more');
check('Tea Green, Aged Brass and the old danger red are gone from the chrome', () => {
  const css = stripComments(styleOf(EDITOR));
  // #6B8E6F is ALSO one of the preview's own greens, so the check is on the
  // rgba() forms the chrome used for its tints — those had no other home.
  for (const dead of ['rgba(107, 142, 111', 'rgba(176, 141, 74', 'rgba(232, 85, 106', '#B08D4A']) {
    assert.ok(!css.includes(dead), `the chrome still paints with ${dead}`);
  }
});
check('Inter is loaded, and is the chrome’s --f-sans', () => {
  assert.ok(/fonts\.googleapis\.com[^"]*family=Inter/.test(EDITOR),
    'the Inter stylesheet is not linked, so the page falls back silently');
  assert.ok(/--f-sans:\s*'Inter'/.test(EDITOR), '--f-sans no longer starts with Inter');
  assert.ok(/'IBM Plex Sans SC'/.test(EDITOR),
    'the Chinese face was dropped with the Latin one — Inter carries no CJK and every label here is bilingual');
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
