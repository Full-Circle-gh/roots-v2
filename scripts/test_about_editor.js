#!/usr/bin/env node
/**
 * The About editor writes the merchant's own story — audit D-04.
 *
 * WHY A SECOND SUITE FOR THE SAME FINDING. D-04 was fixed on the storefront:
 * public/shop.html's renderAbout stopped merging ABOUT_DEFAULTS — the first
 * tenant's manifesto, EST. 2017, MADE IN 广州, the founder's quote, the in/out
 * list — over whatever the shop had written, and now renders only what the
 * shop wrote. That shipped, and it was not enough.
 *
 * The same constant lived a second time in public/retail-admin/10-extras.js,
 * in the EDITOR. loadAbout() merged it over the merchant's stored content and
 * painted it into the form; collectAbout() read the form back. So a merchant
 * who opened the About tab, corrected one word and pressed Save wrote another
 * company's story into their OWN storefront_config.
 *
 * That is strictly worse than the storefront version, and the difference is
 * the reason this suite exists rather than a line in the other one. On the
 * storefront the borrowed copy was only DISPLAYED, so removing the merge
 * removed the defect entirely. Here it was PERSISTED — and content that has
 * been persisted is indistinguishable from content the merchant wrote, so it
 * passes straight through the guard the storefront fix installed. The fix
 * upstream of a fix is the one that actually closes the finding.
 *
 * §4 covers a different bug found in the same function: `hero_image_url` is
 * read by TWO surfaces and was written by none.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const JS = read('public/retail-admin/10-extras.js');
const HTML = read('public/retail-admin.html');

/* COMMENTS ARE STRIPPED BEFORE ANY LITERAL IS HUNTED FOR, and the reason is
   worth a sentence because it bit this suite on its first run. The notes
   explaining WHY the borrowed copy was removed necessarily quote it — "the
   first tenant's manifesto, EST. 2017, MADE IN 广州" — so a search of the raw
   file finds the removal note and reports it as the defect. Stripping is what
   separates "this sentence is in the code" from "this sentence is in the
   explanation of why it is not". Same helper as test_tenant_branding.js. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* The editor's own slice of that file, so a phrase somewhere else in a
   4000-line module cannot make a check pass or fail by accident. */
const EDITOR = JS.slice(JS.indexOf('// ─── About page editor'));
const CODE = strip(EDITOR);

// ─────────────────────────────────────────────────────────────────────────
section('1 · the first tenant\'s copy is not in the editor');

/* Sentences from ABOUT_DEFAULTS as it stood. Each is checked in the EDITOR
   slice — not the whole file — and each is a phrase no other merchant could
   plausibly have written for themselves. */
const BORROWED = [
  ['the manifesto',        'so mind blowing good it transforms how people eat'],
  ['the founder\'s quote', 'plants don\'t have to be the boring option'],
  ['the sign-off',         'From soil to soul.'],
  ['the founding year',    'EST.'],
  ['the city',             'MADE IN'],
  ['the in-list',          'Real fermentation'],
  ['the out-list',         'Cutting corners'],
];
for (const [what, needle] of BORROWED) {
  is(CODE.includes(needle), false, `${what} is gone from the editor`);
}
is(/ABOUT_DEFAULTS/.test(strip(JS)), false, 'and the constant itself no longer exists');

/* The skeleton that replaced it holds field NAMES and no sentences. If a
   future edit puts a value back, this is what catches it: every string
   literal in the shape must be empty. */
{
  const m = CODE.match(/const ABOUT_EMPTY = \{[\s\S]*?\n\};/);
  yes(m, 'ABOUT_EMPTY exists');
  if (m) {
    const values = m[0].match(/:\s*'([^']*)'/g) || [];
    const nonEmpty = values.filter((v) => !/:\s*''$/.test(v));
    is(nonEmpty.length, 0, 'every field in it is empty — it names fields, it does not fill them');
    if (nonEmpty.length) console.log('      ' + nonEmpty.slice(0, 5).join('  '));
    yes(/stats: \[\]/.test(m[0]) && /in_items: \[\]/.test(m[0]) && /out_items: \[\]/.test(m[0]),
      '…and the three lists start empty too');
  }
}

// ─────────────────────────────────────────────────────────────────────────
section('2 · nothing is filled in on load, on either path');

/* Both branches of loadAbout — content found, and no content — plus the catch.
   The old code merged defaults in all three. */
{
  const fn = EDITOR.slice(EDITOR.indexOf('async function loadAbout'), EDITOR.indexOf('function paintAbout()'));
  is(/ABOUT_DEFAULTS/.test(fn), false, 'loadAbout merges no defaults');
  yes(/\{ \.\.\.ABOUT_EMPTY, \.\.\.stored \}/.test(fn),
    'a shop with content gets their content over an empty shape');
  yes(/:\s*\{ \.\.\.ABOUT_EMPTY \}/.test(fn),
    '…and a shop with none gets the empty shape, not somebody else\'s page');
  yes(/ABOUT_STATE\.stats\s*=\s*\[\]/.test(fn),
    'the lists a shop has not written stay empty rather than being seeded');
}

/* THE FAILED-LOAD CASE. The old catch painted defaults, which made a network
   error look like a filled-in page — and then Save would persist it. Now the
   form is empty AND Save is refused, because an empty form saved over a real
   About page erases it. */
{
  yes(/let ABOUT_READY = false;/.test(EDITOR), 'a load either succeeded or it did not, and the editor knows which');
  const save = EDITOR.slice(EDITOR.indexOf('async function saveAbout'), EDITOR.indexOf('ABOUT_IMAGE_FIELDS'));
  yes(/if \(!ABOUT_READY\)/.test(save) && /return;/.test(save),
    'Save is refused after a failed load — an empty form must not overwrite a real page');
  const saveIdx = save.indexOf('if (!ABOUT_READY)');
  const putIdx = save.indexOf('/api/retail-admin/config');
  yes(saveIdx >= 0 && putIdx > saveIdx, '…and the refusal comes before the PUT, not after it');
}

// ─────────────────────────────────────────────────────────────────────────
section('3 · a save never quietly drops what the form has no control for');

/* collectAbout() built a fresh object from the form's own fields, so any key
   the form did not ask about was deleted by the next Save of any other field.
   hero_image_url is exactly such a key — §4 — and it would have been erased
   by somebody fixing a typo in the sign-off. */
{
  const fn = EDITOR.slice(EDITOR.indexOf('function collectAbout'), EDITOR.indexOf('async function saveAbout'));
  yes(/\.\.\.ABOUT_STATE,/.test(fn), 'collectAbout starts from the loaded state');
  const spreadIdx = fn.indexOf('...ABOUT_STATE,');
  const firstField = fn.indexOf("kicker_en: get(");
  yes(spreadIdx >= 0 && firstField > spreadIdx,
    "…and the form's own fields overwrite it, so the spread preserves only what the form never asked about");
  yes(/hero_image_url: ABOUT_STATE\.hero_image_url/.test(fn),
    'the hero survives a save explicitly, not just by accident of the spread');
}

// ─────────────────────────────────────────────────────────────────────────
section('4 · the hero image has a control at all');

/* It was a hardcoded /assets/brand path in public/shop.html — one shop's
   photograph at the top of every shop's story. D-04 removed it and made it
   content. But nothing wrote that content: two surfaces read the key and no
   surface set it, so it was permanently empty for everybody, including the
   shop whose photograph it had been. */
yes(/hero_image_url/.test(read('public/shop.html')), 'the web shop reads a hero from content');
yes(/hero_image_url/.test(read('miniapp/pages/about/about.js')), '…and so does the mini app');
yes(/id="about-hero-file"/.test(HTML) && /id="about-hero-clear"/.test(HTML),
  '…and now something writes it: the editor has an upload and a remove');
yes(/function paintAboutHero/.test(EDITOR), 'the editor previews what is set');
yes(/key: 'hero_image_url'/.test(EDITOR),
  '…through the same upload path as the founder photo rather than a second copy of it');

/* One table drives both images. A second hand-written copy of the upload
   handler is where the two drift apart. */
{
  const uploads = (EDITOR.match(/\/api\/retail-admin\/cms\/media/g) || []).length;
  is(uploads, 1, 'there is exactly one upload handler for both images');
}

/* THE REPAIR SCRIPT'S URL MUST RESOLVE TO A REAL FILE. seed_about_account1.js
   puts the first tenant's original hero back — the picture their written page
   lost when the hardcoded path was removed — and a path that resolves to
   nothing would put a broken image at the top of a live page instead. The URL
   is served through the /assets/ → public/ mapping, the same one server.js
   uses, so the check has to walk that mapping rather than trust the string. */
{
  const seed = read('scripts/seed_about_account1.js');
  const m = seed.match(/hero_image_url = '([^']+)'/);
  yes(m, 'the repair script names a hero URL');
  if (m) {
    const url = m[1];
    yes(url.startsWith('/assets/'), `it is served from /assets/ (${url})`);
    const onDisk = path.join(ROOT, 'public', url.replace(/^\/assets\//, ''));
    yes(fs.existsSync(onDisk), 'and a file is actually there', onDisk);
  }
}

/* The mini app renders the same key. Its header used to promise inlined
   defaults, which stopped being true when they were deleted — a comment that
   describes the opposite of the code is worse than none. */
{
  const mini = read('miniapp/pages/about/about.js');
  is(/Defaults are\s*\n?\/\/ inlined here/.test(mini), false,
    'the mini app no longer claims to inline defaults it does not have');
  is(/const DEFAULTS = \{/.test(mini), false, '…and does not have them');
}

// ─────────────────────────────────────────────────────────────────────────
section('5 · the stat strip is reachable now that it starts empty');

/* It used to arrive with four rows already in it — the first tenant's four —
   so it never needed an add button. Emptied without one, the section would be
   permanently unreachable: a block in the editor that can never hold anything. */
yes(/function aboutAddStat/.test(EDITOR) && /function aboutRemoveStat/.test(EDITOR),
  'rows can be added and removed');
yes(/id="about-stats-add"/.test(HTML), '…and the button exists in the markup');
yes(/ABOUT_MAX_STATS = 4/.test(EDITOR),
  'capped at four, because public/shop.html renders at most four');
yes(/stats\.slice\(0,4\)/.test(read('public/shop.html')),
  '…which is still true of the page it is capped for');

// ─────────────────────────────────────────────────────────────────────────
section('6 · no borrowed copy left in the markup either');

/* A placeholder is grey hint text and is never submitted, so it publishes
   nothing on its own. It is still the first tenant's sentences shown to every
   merchant as the thing to write, which is the same defect one shade fainter.
   The generic role labels (WHO WE ARE, MEET THE FOUNDER, SHOP NOW) stay: they
   name the field, they are not anybody's copy. */
const ABOUT_TAB = HTML.slice(HTML.indexOf('<section id="tab-about">'), HTML.indexOf('</section>', HTML.indexOf('<section id="tab-about">')));
for (const needle of ['We exist to make', '我们存在的意义', 'From soil to soul', '从土壤到灵魂']) {
  is(ABOUT_TAB.includes(needle), false, `no "${needle}" placeholder`);
}
is(/About Roots|关于 Roots/.test(ABOUT_TAB), false,
  'and the tab does not tell every merchant their About page is about another company');

/* The generic ones are load-bearing: with the form empty, a field with no
   placeholder and no value is a blank box. */
for (const needle of ['WHO WE ARE', 'MEET THE FOUNDER', 'OUR PROMISE', 'SHOP NOW']) {
  yes(ABOUT_TAB.includes(needle), `"${needle}" stays — it names the field rather than writing it`);
}

// ─────────────────────────────────────────────────────────────────────────
section('7 · the storefront half is still in place');

/* This suite would pass on its own with the storefront regressed, and the
   finding would still be open. Both halves or neither. */
{
  const shop = strip(read('public/shop.html'));
  is(/ABOUT_DEFAULTS/.test(shop), false, 'the storefront still has no defaults');
  yes(/const stored=\(state\.config&&state\.config\.about&&state\.config\.about\.content\)\|\|null;/.test(shop),
    '…and still renders only what the shop stored');
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
