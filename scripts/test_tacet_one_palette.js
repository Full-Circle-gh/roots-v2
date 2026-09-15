// One design system, three files, one set of values.
//
// WHY THIS EXISTS. Tacet's palette is declared three times over:
//   public/retail-admin.css   --td-*      (Customers, Dashboard, Reports)
//   public/product-editor.html --td-*     (the product page editor)
//   public/cms.html           --tacet-*   (the mini app editor)
// Three files, two naming schemes, one design system — and nothing but a test
// notices when one of them moves. This is the same second-implementation-of-one-
// contract shape scripts/test_product_blocks_read.js holds against the mini
// app's component, and scripts/test_product_editor_tacet.js already holds the
// first two against each other. This file closes the triangle.
//
// THE NAMES ARE NOT UNIFIED, AND THAT IS DELIBERATE. Renaming --tacet-* to
// --td-* across cms.html would touch some six hundred rules to change nothing a
// reader can see, which is a large diff for a small tidiness and a good place
// for a real mistake to hide. The VALUES are what must agree; a mapping table
// below says which name means which, and the test reads that table.
//
// WHAT IS DELIBERATELY NOT CHECKED: the customer's brand. Both editors render
// the customer's own page inside a phone frame — lime, forest, oat in the
// product editor, the --bf-*/--b-* brand faces in the mini app editor — and
// those answer to the tenant, not to this rulebook. Their own suites fence them.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ADMIN  = read('public/retail-admin.css');
const EDITOR = read('public/product-editor.html');
const CMS    = read('public/cms.html');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');

// Every top-level { } block declaring at least one custom property with the
// given prefix, keyed by selector. Comments come out first — retail-admin.css
// writes its hierarchy rule as prose between two declarations.
function tokenBlocks(text, prefix) {
  const out = {};
  const re = /(?:^|\n)[ \t]*([^\n{}][^\n{}]*?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(text)))) {
    const decls = {};
    const dre = new RegExp('(--' + prefix + '[a-z0-9-]+)\\s*:\\s*([^;]+);', 'g');
    let d;
    while ((d = dre.exec(m[2]))) decls[d[1]] = d[2].trim();
    if (Object.keys(decls).length) {
      out[m[1].trim()] = Object.assign(out[m[1].trim()] || {}, decls);
    }
  }
  return out;
}

// name-in-cms.html -> name-in-retail-admin.css. Roles, not spellings: cms.html
// calls the page ground "paper" and the writing "ink"; retail-admin calls them
// --td-paper and --td-text. Same two colours.
const SAME_COLOUR = [
  ['--tacet-ink',        '--td-text'],
  ['--tacet-paper',      '--td-paper'],
  ['--tacet-graphite',   '--td-text2'],
  ['--tacet-dusk',       '--td-dusk'],
  ['--tacet-sage',       '--td-sage'],
  ['--tacet-amber',      '--td-amber'],
  ['--tacet-brick',      '--td-brick'],
  ['--tacet-cream',      '--td-raised'],
  ['--tacet-border',     '--td-border'],
  ['--tacet-dusk-tint',  '--td-dusk-tint'],
  ['--tacet-sage-tint',  '--td-sage-tint'],
  ['--tacet-amber-tint', '--td-amber-tint'],
  ['--tacet-brick-tint', '--td-brick-tint'],
  ['--tacet-sage-ink',   '--td-sage-ink'],
  ['--tacet-amber-ink',  '--td-amber-ink'],
];

const adminTd  = tokenBlocks(ADMIN, 'td-');
const editorTd = tokenBlocks(EDITOR, 'td-');
const cmsTac   = tokenBlocks(CMS, 'tacet-');

// retail-admin.css and product-editor.html are dark-first with a light
// override; cms.html is light-first with a dark override. So "the light
// palette" is assembled differently on each side, and that is what is compared.
const adminLight = Object.assign({}, adminTd[':root'], adminTd[':root[data-theme="light"]']);
const cmsLight   = cmsTac[':root'];

section('The three files agree on the palette');
check('every file still declares one', () => {
  assert.ok(Object.keys(adminTd).length,  'retail-admin.css declares no --td-* block');
  assert.ok(Object.keys(editorTd).length, 'product-editor.html declares no --td-* block');
  assert.ok(Object.keys(cmsTac).length,   'cms.html declares no --tacet-* block');
});
check('cms.html and retail-admin.css name the same colours, value for value', () => {
  const drift = [];
  for (const [tac, td] of SAME_COLOUR) {
    const a = cmsLight[tac], b = adminLight[td];
    if (!a) { drift.push(`${tac} is gone from cms.html`); continue; }
    if (!b) { drift.push(`${td} is gone from retail-admin.css`); continue; }
    if (a.toLowerCase() !== b.toLowerCase()) {
      drift.push(`${tac} = ${a} in cms.html, but ${td} = ${b} in retail-admin.css`);
    }
  }
  assert.deepStrictEqual(drift, [],
    'the palette has drifted between the two editors:\n      ' + drift.join('\n      '));
});
check('product-editor.html matches retail-admin.css too (the third side)', () => {
  const drift = [];
  for (const sel of Object.keys(editorTd)) {
    const theirs = adminTd[sel] || {};
    for (const k of Object.keys(editorTd[sel])) {
      if (!(k in theirs)) drift.push(`${sel} { ${k} } exists only in product-editor.html`);
      else if (theirs[k] !== editorTd[sel][k]) {
        drift.push(`${sel} { ${k} }: ${theirs[k]} vs ${editorTd[sel][k]}`);
      }
    }
  }
  assert.deepStrictEqual(drift, [], drift.join('\n      '));
});

section('One primary action, one colour, on every screen');
check('THE PRIMARY IS INK, NOT DUSK — in both editors', () => {
  /* Dusk is the AI's colour: "Tacet did this for you." Saving or publishing
     your own work is the MERCHANT acting. retail-admin.css says so beside the
     Customers modal in as many words. cms.html pointed --brass at Dusk until
     2026-09-15, which made Publish purple in the mini app editor while the same
     button was Ink in the product editor and on Customers — one operator, three
     screens, and purple meaning two different things. */
  const brass = (stripComments(CMS).match(/--brass:\s*([^;]+);/) || [])[1];
  assert.ok(brass, 'cms.html no longer declares --brass at all');
  assert.ok(!/dusk/i.test(brass),
    `cms.html points its primary action at ${brass.trim()} — Dusk is the AI's colour, not the merchant's`);
});
check('...and the dark room inverts it, so the button does not vanish', () => {
  /* Ink on an Ink ground is an invisible button. The dark block must restate
     --brass the way it already restates --accent; the light half of a theme is
     not the whole of it. */
  const dm = stripComments(CMS).match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\s*\}/);
  const dark = dm ? dm[1] : '';
  assert.ok(/--brass:/.test(dark),
    'the dark theme never restates --brass, so the primary is Ink on an Ink ground');
});
check('a filled primary carries the theme’s paper, never a literal white', () => {
  // On the dark room the fill inverts to Paper, and white-on-Paper is unreadable.
  const rules = stripComments(CMS).match(/\.btn-primary\s*\{[^{}]*\}/g) || [];
  assert.ok(rules.length, '.btn-primary is gone from cms.html');
  for (const r of rules) {
    assert.ok(!/color:\s*#(?:fff|FFF|ffffff|FFFFFF)\b/.test(r),
      'a .btn-primary rule still hardcodes white: ' + r.replace(/\s+/g, ' ').slice(0, 90));
  }
});

section('The mini app editor obeys the rulebook');
// The phone renders the CUSTOMER'S page: .b-* are the block renderers, .fsd-*
// the flash-sale display, .phone the device mock itself. .phone-preview-* is
// NOT the device — it is the "Preview on phone" modal, which is chrome and
// shares only a prefix. That distinction cost a wrong pass; it is encoded here.
const PREVIEW = /\.(b-|fsd-)|\.phone(?!-preview)/;
function chromeRules(html) {
  let css = '';
  const sre = /<style>([\s\S]*?)<\/style>/g;
  let s;
  while ((s = sre.exec(html))) css += s[1] + '\n';
  const out = [];
  const re = /(?:^|\n)[ \t]*([^\n{}][^\n{}]*?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(css)))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@') || PREVIEW.test(sel)) continue;
    out.push({ sel, body: m[2] });
  }
  return out;
}
const CMS_CHROME = chromeRules(CMS);

check('it has chrome rules to check at all', () => {
  assert.ok(CMS_CHROME.length > 300, `only ${CMS_CHROME.length} chrome rules found — the parser has lost the stylesheet`);
});
check('NO UPPERCASE ANYWHERE — §1.6', () => {
  const shouting = CMS_CHROME.filter(r => /text-transform:\s*uppercase/.test(r.body)).map(r => r.sel);
  assert.deepStrictEqual(shouting, [], 'these chrome rules still shout: ' + shouting.join(', '));
});
check('Inter 400/500 only — the font: shorthand counts too', () => {
  // The shorthand is where the first pass missed five rules: `font: 700 11px …`
  // sets a weight without ever writing `font-weight`.
  const heavy = CMS_CHROME.filter(r =>
    /font-weight:\s*(?:[6-9]00|bold)\b/.test(r.body) || /font:\s*(?:[6-9]00|bold)\b/.test(r.body)
  ).map(r => r.sel);
  assert.deepStrictEqual(heavy, [], 'these chrome rules set a weight above 500: ' + heavy.join(', '));
});

section('The customer’s page is not repainted by the chrome');
check('the brand faces are still the preview’s own', () => {
  for (const v of ['--bf-bear', '--bf-toni', '--bf-gothic', '--bf-yuan']) {
    assert.ok(CMS.includes(v), `${v} is gone — the preview has been "tidied" onto chrome type`);
  }
});
check('and the block renderers still carry their own weights and caps', () => {
  /* The fence has to be proved from BOTH sides: the chrome checks above pass
     trivially if the preview rules were swept along with them. The customer's
     blocks are editorial — a lime announcement bar in caps, a Bear Serif
     headline at 700 — and they must still be able to say so. */
  let css = '';
  const sre = /<style>([\s\S]*?)<\/style>/g;
  let s;
  while ((s = sre.exec(CMS))) css += s[1] + '\n';
  const re = /(?:^|\n)[ \t]*([^\n{}][^\n{}]*?)\s*\{([^{}]*)\}/g;
  let m, loud = 0;
  while ((m = re.exec(stripComments(css)))) {
    if (!PREVIEW.test(m[1])) continue;
    if (/text-transform:\s*uppercase|font-weight:\s*[6-9]00|font:\s*[6-9]00/.test(m[2])) loud++;
  }
  assert.ok(loud >= 20,
    `only ${loud} preview rules still set caps or a heavy weight — the chrome pass has reached into the phone`);
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
