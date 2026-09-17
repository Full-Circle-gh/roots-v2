#!/usr/bin/env node
/**
 * test_brand_signature.js — nobody's product page is signed by somebody else.
 *
 *   node scripts/test_brand_signature.js
 *
 * WHAT THIS IS FOR (§158; §156 recorded this half as owed and more urgent).
 *
 * A Roots product page ends in a colophon: an illustrated character, a house
 * line ("From Soil to Soul"), and a name on a hairline rule ("Roots · ESTD
 * 2017"). Every part was a literal in the surfaces that draw it — the product
 * page editor, and miniapp/pages/product/product.js.
 *
 * THE MINI APP IS PUBLISHED ONCE PER TENANT off this one shared codebase, each
 * under its own WeChat AppID (miniapp/utils/api.js). So those literals were not
 * Roots' page signing itself. They were every merchant's SHOPPER-FACING product
 * page signing itself as Roots — and the category map's `soilsoul` fallback made
 * that the default rather than an edge case: a shop that had chosen nothing got
 * Roots' mascot drawn onto its product, with nobody having touched anything.
 *
 * THE THREE CLAIMS THIS FILE KEEPS HONEST
 *
 *  1. ROOTS IS UNCHANGED, byte for byte. If the cast, the map, the fallback,
 *     the house line or the tagline came back even slightly different, this
 *     would be a regression wearing the clothes of a principle.
 *  2. NOBODY ELSE GETS ANY OF IT — no cast, no map, no slogan — and gets its
 *     OWN name or nothing. A platform cannot invent a merchant's motto, and a
 *     colophon printing one it made up is worse than a colophon with no line.
 *  3. THE MINI APP'S COPY OF THE RULE STILL AGREES. A WeChat bundle cannot
 *     require from lib/, so resolveColophonCharacter() in the page is a real and
 *     permanent duplication of lib/brand-signature.resolveCharacter(). This
 *     lifts the mini app's function out of the shipped file and runs it against
 *     the same cases as the server's — the only thing standing between one rule
 *     and two silently different ones. Same pattern and same reason as
 *     test_nutrition_rows.js.
 *
 * EXIT  0 every assertion held · 1 an assertion failed
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const sigLib = require(path.join(ROOT, 'lib', 'brand-signature.js'));
const { signatureFor, resolveCharacter } = sigLib;

const MINIAPP_PRODUCT = fs.readFileSync(path.join(ROOT, 'miniapp/pages/product/product.js'), 'utf8');
const MINIAPP_WXML    = fs.readFileSync(path.join(ROOT, 'miniapp/pages/product/product.wxml'), 'utf8');
const RETAIL_JS       = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const EDITOR          = fs.readFileSync(path.join(ROOT, 'public', 'product-editor.html'), 'utf8');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

// Lift a top-level `function name(...) {...}` out of a source file and make it
// callable. Fails on the anchor rather than passing against nothing.
function liftFunction(src, name, label) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  assert.ok(m, `${name}() not found in ${label} — the anchor moved, so this proves nothing`);
  let i = m.index + m[0].length, depth = 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  const body = src.slice(m.index, i);
  // eslint-disable-next-line no-new-func
  return new Function(body + '\nreturn ' + name + ';')();
}

const ROOTS = signatureFor(null);
const OTHER = signatureFor({ id: 7, name: 'Nine Lanterns', brand_name: '' });

// ═══════════════════════════════════════════════════════════════════════════
section('1. Roots is unchanged, byte for byte');
// ═══════════════════════════════════════════════════════════════════════════

check('the cast is the same ten characters, in the same order', () => {
  assert.deepStrictEqual(ROOTS.characters.map(c => c.key), [
    'soilsoul', 'skater', 'kombucha-gang', 'flex', 'radishes',
    'mushroom', 'peas', 'onion', 'broccoli', 'hula',
  ]);
  assert.strictEqual(ROOTS.characters[0].label, 'Soil & Soul');
});

check('every character has an image file on disk', () => {
  for (const c of ROOTS.characters) {
    const f = path.join(ROOT, 'public/brand/ip-' + c.key + '.jpg');
    assert.ok(fs.existsSync(f), `no image for "${c.key}" — the colophon would render a broken tile`);
  }
});

check('the house line and both taglines are the strings that shipped', () => {
  assert.strictEqual(ROOTS.house, 'Roots · ESTD 2017');
  assert.strictEqual(ROOTS.tagline_en, 'From Soil to Soul');
  assert.strictEqual(ROOTS.tagline_cn, '从土壤到灵魂');
});

check('an absent tenant and tenant #1 are the same answer', () => {
  /* The kitchen realm carries no tenant row and the kitchen IS account #1 —
     the same equivalence composeSystem(shop) in routes/ai.js already relies on.
     A public request for Roots also resolves to null (resolvePublicTenant
     returns null for the Roots tenant), so this is the live path, not a corner. */
  assert.deepStrictEqual(signatureFor(undefined), ROOTS);
  assert.deepStrictEqual(signatureFor({ id: 1, name: 'Roots' }), ROOTS);
  assert.deepStrictEqual(signatureFor({ id: '1' }), ROOTS, 'a string id must not fall through to "not Roots"');
});

check('the category map still files every character it used to', () => {
  const cases = [
    ['Sauces & dips', 'soilsoul'],
    ['Nut butter / spread', 'skater'],
    ['Kombucha', 'kombucha-gang'],
    ['Protein powder', 'flex'],
    ['Root vegetables', 'radishes'],
    ['Mushroom', 'mushroom'],
    ['Legumes', 'peas'],
    ['Garlic & onion', 'onion'],
    ['Leafy greens', 'broccoli'],
  ];
  for (const [cat, want] of cases) {
    assert.strictEqual(resolveCharacter(ROOTS, '', cat), want, `${cat} → expected ${want}`);
  }
});

check('an unmapped category still falls back to Soil & Soul, for Roots only', () => {
  assert.strictEqual(resolveCharacter(ROOTS, '', 'Stationery'), 'soilsoul');
  assert.strictEqual(resolveCharacter(ROOTS, '', ''), 'soilsoul');
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. Nobody else is signed as Roots');
// ═══════════════════════════════════════════════════════════════════════════

check('another tenant gets no cast, no map and no slogan', () => {
  assert.strictEqual(OTHER.characters.length, 0, 'a stranger was handed Roots\' cast');
  assert.strictEqual(OTHER.auto_map.length, 0, 'a stranger was handed Roots\' category map');
  assert.strictEqual(OTHER.fallback_character, '', 'a stranger has a default character');
  assert.strictEqual(OTHER.tagline_en, '', 'the platform invented an English slogan');
  assert.strictEqual(OTHER.tagline_cn, '', 'the platform invented a Chinese slogan');
  assert.ok(!JSON.stringify(OTHER).includes('Roots'), 'the word Roots reached another tenant\'s signature');
  assert.ok(!JSON.stringify(OTHER).includes('soilsoul'), 'soilsoul reached another tenant\'s signature');
});

check('it gets its OWN name, preferring the brand name over the account name', () => {
  assert.strictEqual(OTHER.house, 'Nine Lanterns');
  assert.strictEqual(signatureFor({ id: 7, name: 'acct-7', brand_name: 'Kite & Co' }).house, 'Kite & Co');
});

check('a nameless tenant gets an empty rule, never the word undefined', () => {
  for (const t of [{ id: 7 }, { id: 7, name: null }, { id: 7, name: '   ' }]) {
    const h = signatureFor(t).house;
    assert.strictEqual(h, '', `house was "${h}"`);
    assert.ok(!/undefined|null/.test(h));
  }
});

check('with no cast, nothing is drawn — not even for a mapped category', () => {
  assert.strictEqual(resolveCharacter(OTHER, '', 'Sauces & dips'), '',
    'a category match drew a character this shop does not have');
  assert.strictEqual(resolveCharacter(OTHER, '', ''), '',
    'the fallback drew a character this shop does not have — that was the default that signed every page');
});

check('a character the shop does not have is refused even when it is asked for by the map', () => {
  /* The guard is on the RESOLVED key, not on the shop being non-Roots: a
     signature whose map points at a character its own cast has since lost must
     draw nothing rather than a broken tile. */
  const stale = { characters: [{ key: 'peas', label: 'Peas' }],
                  auto_map: [['(sauce)', 'soilsoul']], fallback_character: 'soilsoul' };
  assert.strictEqual(resolveCharacter(stale, '', 'sauce'), '');
  assert.strictEqual(resolveCharacter(stale, '', 'legume'), '', 'the fallback is not checked against the cast');
  assert.strictEqual(resolveCharacter(stale, '', 'peas'), '', 'peas is not in that map, so nothing should match');
});

check('an override the office typed is always honoured, cast or no cast', () => {
  /* It is the product's stored choice. Second-guessing it would blank a page
     somebody deliberately signed, and would silently drop a character the shop
     uploaded after this signature was cached. */
  assert.strictEqual(resolveCharacter(OTHER, 'their-own-mascot', ''), 'their-own-mascot');
  assert.strictEqual(resolveCharacter(ROOTS, 'hula', 'Sauces & dips'), 'hula',
    'the override lost to the category map');
  assert.strictEqual(resolveCharacter({}, '  spaced  ', ''), 'spaced', 'the override is not trimmed');
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. The mini app\'s copy of the rule still agrees');
// ═══════════════════════════════════════════════════════════════════════════

const miniResolve = liftFunction(MINIAPP_PRODUCT, 'resolveColophonCharacter', 'the mini app product page');

check('it answers identically to the server on every case above', () => {
  const sigs = [ROOTS, OTHER, {}, { characters: [{ key: 'peas' }], auto_map: [['(sauce)', 'soilsoul']], fallback_character: 'soilsoul' }];
  const overrides = ['', 'hula', 'their-own-mascot', '  spaced  '];
  const cats = ['Sauces & dips', 'Kombucha', 'Leafy greens', 'Stationery', '', null];
  let compared = 0;
  for (const s of sigs) for (const o of overrides) for (const c of cats) {
    const a = resolveCharacter(s, o, c);
    const b = miniResolve(s, o, c);
    assert.strictEqual(b, a,
      `diverged on (cast=${(s.characters || []).length}, override="${o}", category="${c}"): server "${a}", mini app "${b}"`);
    compared++;
  }
  assert.ok(compared >= 90, `only ${compared} cases compared`);
});

check('a malformed map breaks neither copy', () => {
  /* The map arrives over the wire as JSON. A bad regexp or a short pair must be
     skipped, not thrown — a crash here would take down the whole product page. */
  const broken = { characters: [{ key: 'peas' }], auto_map: [['(unclosed', 'peas'], ['x'], null, ['(pea)', 'peas']], fallback_character: '' };
  assert.strictEqual(resolveCharacter(broken, '', 'peas'), 'peas');
  assert.strictEqual(miniResolve(broken, '', 'peas'), 'peas');
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. No surface holds a copy of the DATA');
// ═══════════════════════════════════════════════════════════════════════════

check('the mini app names no character, slogan or house of its own', () => {
  // Comments are stripped: the commentary explaining the fix names the very
  // strings it removed, so a raw search reports the explanation as the fault.
  const code = MINIAPP_PRODUCT.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const leak of ['soilsoul', 'From Soil to Soul', '从土壤到灵魂', 'ESTD 2017', 'kombucha-gang']) {
    assert.ok(!code.includes(leak), `the mini app still names "${leak}"`);
  }
  assert.ok(/config\.get\('colophon'/.test(code),
    'the page does not read the signature off the storefront config');
});

check('the mini app markup prints no name of its own, and hides each empty part', () => {
  assert.ok(!MINIAPP_WXML.includes('Roots · ESTD 2017'),
    'the shopper-facing markup still prints Roots\' name on every tenant\'s page');
  assert.ok(/\{\{colophonHouse\}\}/.test(MINIAPP_WXML), 'the rule does not bind the shop\'s own name');
  for (const g of ['colophonShow', 'colophonImg', 'colophonTagline', 'colophonHouse']) {
    assert.ok(new RegExp('wx:if="\\{\\{' + g + '\\}\\}"').test(MINIAPP_WXML),
      `${g} is rendered without a guard — an empty part leaves a gap or a hairline with nothing on it`);
  }
});

check('every field the markup binds is actually set by the page', () => {
  for (const f of ['colophonHouse', 'colophonShow']) {
    assert.ok(new RegExp('^\\s+' + f + ',$', 'm').test(MINIAPP_PRODUCT),
      `${f} is bound in the wxml but never passed to setData — it would render blank forever`);
    assert.ok(new RegExp(f + ':').test(MINIAPP_PRODUCT), `${f} is missing from the page's data defaults`);
  }
});

check('the server holds ONE copy, read by both the operator and the public route', () => {
  assert.ok(!/const ROOTS_IP_CHARACTERS = \[/.test(RETAIL_JS),
    'routes/retail.js still keeps its own cast — a second copy is a second answer');
  const admin = RETAIL_JS.indexOf("router.get('/api/retail-admin/brand/signature'");
  assert.notStrictEqual(admin, -1, 'the operator signature route is gone');
  assert.ok(/brandSignature\.signatureFor\(req\.tenant\)/.test(RETAIL_JS.slice(admin, admin + 400)),
    'the operator route does not answer from the shared module');
  const pub = RETAIL_JS.indexOf("cfg.colophon = brandSignature.signatureFor");
  assert.notStrictEqual(pub, -1, 'the public config does not carry a colophon, so the mini app has nothing to read');
  assert.ok(/resolvePublicTenant\(req\)/.test(RETAIL_JS),
    'the public config does not resolve the tenant, so every shop would get the same signature');
});

check('the editor still holds no cast either (§156 held)', () => {
  assert.ok(/let PA_IP_CHARACTERS = \[\s*\];/.test(EDITOR), 'the editor grew a cast back');
  assert.ok(/brand\/signature/.test(EDITOR), 'the editor no longer asks for the signature');
});

console.log(fail ? `\n${fail} check(s) failed\n` : `\nAll ${pass} checks passed\n`);
process.exit(fail ? 1 : 0);
