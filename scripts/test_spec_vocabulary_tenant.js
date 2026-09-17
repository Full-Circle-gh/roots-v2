#!/usr/bin/env node
//
// test_spec_vocabulary_tenant.js — the spec strip's words belong to the shop
// that typed them, and the colophon's cast belongs to the shop that drew it.
//
// WHAT THIS IS FOR
// ----------------
// §155. §145 gave the spec strip two dropdowns and filled both languages from
// one pick, which is the half that matters — a typed label is one somebody can
// finish in English and forget in the Chinese. But the lists it offered were
// Roots' own catalogue compiled into public/product-editor.html: `Guangzhou,
// China` under Origin, `See packaging` under Shelf Life, `100% plant` under
// Diet. Every one of those is a real measurement of Roots' 260 products and
// every one is nonsense for a candle shop in Shanghai, which was being offered
// a Guangzhou origin and a vegan claim in the same control that elsewhere
// carries measured fact. The colophon had the same shape of fault with Roots'
// ten illustrated characters.
//
// THE CLAIM THIS FILE KEEPS HONEST is not "the lists moved". It is that the
// SAME ANSWERS come back for Roots when they are counted rather than typed —
// otherwise this is a regression dressed as a principle — and that a shop with
// no history is offered nothing at all rather than somebody else's defaults.
//
// HOW IT RUNS THE REAL CODE — nothing here is a paraphrase.
//   * The counter is LIFTED OUT of routes/retail.js by its route handler and
//     executed against fixture rows shaped exactly like description_blocks.
//     A rewritten predicate fails here; a copy of it in this file would not.
//   * The editor's own lookups are executed in a vm against the shipped source.
//
// USAGE   node scripts/test_spec_vocabulary_tenant.js
// EXIT    0 every assertion held · 1 an assertion failed
'use strict';

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const assert = require('assert');

const ROOT      = path.join(__dirname, '..');
const RETAIL_JS = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');
const EDITOR    = fs.readFileSync(path.join(ROOT, 'public', 'product-editor.html'), 'utf8');
// The same source with whole-line `//` comments dropped. The checks below ask
// whether the page still PRINTS Roots' slogan and name, and the commentary
// explaining why it no longer does says both of them out loud — so a search
// over the raw file reports the explanation as the fault. Only full-line
// comments are removed, which cannot swallow a `https://` inside a string.
const EDITOR_CODE = EDITOR.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function section(t) { console.log('\n' + t); }

// ── The counter, taken out of the shipped route ─────────────────────────────
// Anchored on the route registration and read to the end of its handler by
// brace balance, so a moved handler fails on the anchor rather than passing
// against nothing.
const SPEC_HANDLER = (() => {
  const at = RETAIL_JS.indexOf("router.get('/api/retail-admin/products/spec-usage'");
  assert.notStrictEqual(at, -1, 'the spec-usage route is not in routes/retail.js');
  const open = RETAIL_JS.indexOf('{', RETAIL_JS.indexOf('(req, res) =>', at));
  let i = open, depth = 0;
  for (; i < RETAIL_JS.length; i++) {
    if (RETAIL_JS[i] === '{') depth++;
    else if (RETAIL_JS[i] === '}') { depth--; if (!depth) break; }
  }
  return RETAIL_JS.slice(open + 1, i);
})();

// Run the handler body against fixture rows. tdb() and res are stubbed; the
// arithmetic between them is the shipped code, character for character.
function countSpecs(rows) {
  let out = null;
  const sandbox = {
    console,
    tdb: () => ({ prepare: () => ({ all: () => rows }) }),
    res: { set() {}, json(v) { out = v; }, status() { return this; } },
    req: {},
    JSON, Map, Set, Array, String, Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(SPEC_HANDLER, sandbox, { filename: 'spec-usage handler' });
  assert.ok(out, 'the handler answered nothing');
  return out;
}
const prod = (...cells) => ({
  description_blocks: JSON.stringify([{ type: 'spec_strip', cells }]),
});
const cell = (kEn, kCn, vEn, vCn) => ({ k_en: kEn, k_cn: kCn, v_en: vEn, v_cn: vCn });

// ═══════════════════════════════════════════════════════════════════════════
section('1. The shop\'s own words, counted');
// ═══════════════════════════════════════════════════════════════════════════

check('a value is offered because the shop says it, not because it was compiled in', () => {
  // A candle shop in Shanghai. Nothing about it resembles Roots.
  const out = countSpecs([
    prod(cell('Origin', '产地', 'Shanghai, China', '中国上海')),
    prod(cell('Origin', '产地', 'Shanghai, China', '中国上海')),
    prod(cell('Origin', '产地', 'Vietnam', '越南')),
  ]);
  const origin = out.values['origin'];
  assert.ok(origin, 'Origin has no values at all');
  assert.strictEqual(origin[0].en, 'Shanghai, China', 'the commonest value is not first');
  assert.strictEqual(origin[0].cn, '中国上海', 'the pick would fill only one language');
  assert.strictEqual(origin[0].n, 2);
  assert.ok(!JSON.stringify(out).includes('Guangzhou'),
    'a shop that has never said Guangzhou is being offered it');
});

check('a shop with no history is offered nothing rather than somebody else\'s defaults', () => {
  const out = countSpecs([]);
  // Length, not deepStrictEqual: the array is built inside the vm, so its
  // prototype is that realm's and a structural compare fails on identity.
  assert.strictEqual(out.labels.length, 0, 'a brand-new tenant was handed labels it never typed');
  assert.strictEqual(Object.keys(out.values).length, 0,
    'a brand-new tenant was handed values it never typed');
});

check('Roots\' own measured list comes back when it is counted instead of typed', () => {
  // The §145 measurement, in miniature: Origin is Guangzhou on most cells,
  // Shelf Life is "See packaging", Diet is "100% plant". Counting has to
  // reproduce the list that was typed in, or this change is a regression.
  const rows = [];
  for (let i = 0; i < 109; i++) rows.push(prod(cell('Origin', '产地', 'Guangzhou, China', '中国广州')));
  for (let i = 0; i < 15; i++)  rows.push(prod(cell('Origin', '产地', 'China', '中国')));
  for (let i = 0; i < 46; i++)  rows.push(prod(cell('Shelf Life', '保质期', 'See packaging', '见包装标示')));
  for (let i = 0; i < 28; i++)  rows.push(prod(cell('Diet', '饮食', '100% plant', '纯植物')));
  const out = countSpecs(rows);
  assert.strictEqual(out.values['origin'][0].en, 'Guangzhou, China');
  assert.strictEqual(out.values['origin'][1].en, 'China');
  assert.strictEqual(out.values['shelf life'][0].cn, '见包装标示');
  assert.strictEqual(out.values['diet'][0].cn, '纯植物');
  assert.strictEqual(out.labels[0].en, 'Origin', 'the commonest label is not first');
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. Half a pair is not an answer');
// ═══════════════════════════════════════════════════════════════════════════
// The entire point of the control is that ONE PICK FILLS BOTH LANGUAGES. A list
// built from half-written cells would offer a pair whose Chinese is blank —
// which is the exact fault §145 built the dropdown to stop, re-entering through
// the list rather than the keyboard.

check('a cell with no Chinese is never promoted into the list', () => {
  const out = countSpecs([
    prod(cell('Origin', '产地', 'Shanghai, China', '')),
    prod(cell('Origin', '产地', 'Shanghai, China', '')),
    prod(cell('Origin', '产地', 'Vietnam', '越南')),
    prod(cell('Origin', '产地', 'Vietnam', '越南')),
  ]);
  // Shanghai is the commoner answer and is still not offered: it has no 中文,
  // and a pick that fills one language is the fault the dropdown exists to stop.
  assert.strictEqual(out.values['origin'].length, 1, 'a half-written pair reached the list');
  assert.strictEqual(out.values['origin'][0].en, 'Vietnam');
});

// §145 gave Net Wt no value list on purpose: 163 cells held 67 distinct
// weights, and a dropdown nobody can find their product in is worse than a
// typed box. A per-tenant count cannot carry a hard-coded exception for the
// words "net wt", so the judgement is read off the data instead — an answer
// has to have been used twice before it is offered back.
check('an answer used once is not a list, however common its label is', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(prod(cell('Net Wt', '净含量', (i * 10) + 'g', (i * 10) + '克')));
  const out = countSpecs(rows);
  assert.strictEqual(out.labels[0].en, 'Net Wt', 'the label itself must still be offered');
  assert.strictEqual(out.values['net wt'], undefined,
    'twenty one-off weights became a dropdown — that is the list §145 refused');
});

check('but the sizes a shop actually repeats do become one', () => {
  const rows = [];
  for (let i = 0; i < 9; i++) rows.push(prod(cell('Net Wt', '净含量', '250g', '250克')));
  for (let i = 0; i < 4; i++) rows.push(prod(cell('Net Wt', '净含量', '500g', '500克')));
  rows.push(prod(cell('Net Wt', '净含量', '1.7kg', '1.7公斤')));   // a one-off, and stays out
  const out = countSpecs(rows);
  assert.strictEqual(out.values['net wt'].length, 2, 'the one-off weight reached the list');
  assert.strictEqual(out.values['net wt'][0].en, '250g');
});

check('a label with no Chinese takes its values down with it', () => {
  const out = countSpecs([prod(cell('Origin', '', 'Vietnam', '越南'))]);
  assert.strictEqual(out.labels.length, 0, 'a label with no Chinese was offered');
  assert.strictEqual(out.values['origin'], undefined,
    'values were counted under a label that cannot be picked');
});

check('the commonest SPELLING of a pair represents it', () => {
  // `Net Wt` 3, `Net wt` 1 — one row in the dropdown, spelled the way the shop
  // mostly spells it, and counted as all four.
  const out = countSpecs([
    prod(cell('Net Wt', '净含量', '250g', '250克')),
    prod(cell('Net Wt', '净含量', '250g', '250克')),
    prod(cell('Net Wt', '净含量', '250g', '250克')),
    prod(cell('Net wt', '净含量', '250g', '250克')),
  ]);
  assert.strictEqual(out.labels.length, 1, 'a spelling variant became a second label');
  assert.strictEqual(out.labels[0].en, 'Net Wt');
  assert.strictEqual(out.labels[0].n, 4, 'the variant was not counted toward the same label');
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. The editor asks, and copes when nobody answers');
// ═══════════════════════════════════════════════════════════════════════════

// The editor's lookups, executed rather than grepped: a vm holding just the
// declarations and the two functions that read them.
function editorSandbox() {
  const grab = (re, what) => {
    const m = re.exec(EDITOR);
    assert.ok(m, `${what} is not in product-editor.html`);
    return m[0];
  };
  const src = [
    grab(/const PA_SPEC_LABELS = \[[\s\S]*?\n\];/, 'PA_SPEC_LABELS'),
    // `var`, NOT `let`. A let binding does not attach to the context's global
    // object, so `sandbox.PA_SPEC_VALUES = …` from out here would leave the
    // real binding untouched and the assertion would pass against a value it
    // had never set. Two checks in this file did exactly that before it was
    // caught by a THIRD check failing for the same reason.
    'var PA_SPEC_VALUES = null; var PA_SPEC_LABELS_OWN = [];',
    grab(/function paSpecLabels\(\) \{[\s\S]*?\n\}/, 'paSpecLabels()'),
    grab(/function paSpecValuesFor\(labelEn\) \{[\s\S]*?\n\}/, 'paSpecValuesFor()'),
  ].join('\n');
  const sandbox = { console, Array, String, Set };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'editor-spec' });
  return sandbox;
}

check('no value list is offered before the count lands', () => {
  const box = editorSandbox();
  assert.strictEqual(box.paSpecValuesFor('Origin'), null,
    'a dropdown is offered while PA_SPEC_VALUES is still null');
});

check('a failed count offers free text, never a stale guess', () => {
  const box = editorSandbox();
  box.PA_SPEC_VALUES = {};          // the route answered, and this shop has none
  assert.strictEqual(box.paSpecValuesFor('Origin'), null);
  assert.strictEqual(box.paSpecValuesFor('anything'), null);
});

check('the house labels are neutral — no place, no diet, no trade', () => {
  const box = editorSandbox();
  const en = box.paSpecLabels().map(o => o.en.toLowerCase()).join(' | ');
  for (const leak of ['guangzhou', 'china', 'plant', 'vegan', 'packaging']) {
    assert.ok(!en.includes(leak), `the label list names "${leak}" — that is an answer, not a row name`);
  }
  assert.ok(box.paSpecLabels().every(o => o.en && o.cn),
    'a house label is missing one of its two languages');
});

check('a tenant\'s own label is offered beside the house ones, never instead of them', () => {
  const box = editorSandbox();
  const houseCount = box.paSpecLabels().length;
  box.PA_SPEC_LABELS_OWN = [{ en: 'Fabric', cn: '面料' }];
  const merged = box.paSpecLabels();
  assert.strictEqual(merged.length, houseCount + 1, 'merging replaced the house list');
  assert.strictEqual(merged[merged.length - 1].en, 'Fabric', 'the shop\'s own label was dropped');
  assert.ok(merged.some(o => o.en === 'Origin'), 'a house label was lost in the merge');
});

check('the values a cell is offered follow the label it is under', () => {
  const box = editorSandbox();
  box.PA_SPEC_VALUES = { 'origin': [{ en: 'Vietnam', cn: '越南', n: 2 }] };
  assert.strictEqual(box.paSpecValuesFor('Origin').length, 1, 'the lookup is case-sensitive');
  assert.strictEqual(box.paSpecValuesFor('  origin  ').length, 1, 'the lookup does not trim');
  assert.strictEqual(box.paSpecValuesFor('Net Wt'), null,
    'an origin is being offered as an answer to a weight');
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. Nobody signs a page with somebody else\'s mascot');
// ═══════════════════════════════════════════════════════════════════════════

check('the editor offers no cast of its own', () => {
  const m = /let PA_IP_CHARACTERS = (\[\s*\]);/.exec(EDITOR);
  assert.ok(m, 'PA_IP_CHARACTERS is not an empty list in the editor');
  // The grid and the fold are driven by that list alone.
  for (const label of ['Soil & Soul', 'Kombucha', 'Radishes']) {
    assert.ok(!EDITOR_CODE.includes(label),
      `the editor still names the character "${label}" — every tenant would be shown it`);
  }
});

// PA_COLOPHON_AUTO_MAP files Roots' cast by what Roots sells, and it is NOT the
// fault: it is a perfectly good map for the shop it was written for. The fault
// was resolving through it unconditionally, with a literal `soilsoul` fallback,
// so a tenant who had chosen nothing got Roots' character drawn on their page
// by default — worse than the grid, because it needed no operator action.
check('the auto-pick can only ever pick a character this shop has', () => {
  const at = EDITOR.indexOf('function _paResolveColophonChar(');
  assert.notStrictEqual(at, -1, '_paResolveColophonChar has moved');
  const body = EDITOR.slice(at, EDITOR.indexOf('\n}', at));
  assert.ok(/if \(!PA_IP_CHARACTERS\.length\) return '';/.test(body),
    'a shop with no cast still falls through to the category map');
  assert.ok(/_paHasCharacter\(key\)/.test(body),
    "the map's answer is returned without checking the shop actually has it");
  assert.ok(!/return 'soilsoul'/.test(body),
    'the bare soilsoul fallback is still there — that is the default that signed every page');
});

// The two other literals in the same colophon: Roots' slogan and Roots' name,
// both printed into every tenant's preview.
check('the preview signs with this shop\'s line and name, or with none', () => {
  assert.ok(!EDITOR_CODE.includes('Roots · ESTD 2017'),
    "the preview still prints Roots' name on every tenant's colophon");
  assert.ok(!EDITOR_CODE.includes('From Soil to Soul') && !EDITOR_CODE.includes('从土壤到灵魂'),
    "the preview or a placeholder still falls back to Roots' slogan");
  // Both colophons — the live preview AND the template thumbnail. The second
  // one was missed on the first pass and found by this check.
  // Counted on the guard rather than the class name: `.pa-prev-colophon-meta`
  // also has a CSS rule, so matching the class finds three and the third is a
  // stylesheet.
  assert.strictEqual((EDITOR_CODE.match(/PA_SIGNATURE\.house \?/g) || []).length, 2,
    'a colophon footer appeared or disappeared — check both renders sign the same way');
  assert.ok(!/ip-soilsoul\.jpg/.test(EDITOR_CODE),
    'a colophon still hard-codes a Roots portrait');
  assert.ok(/PA_SIGNATURE\.house/.test(EDITOR) && /PA_SIGNATURE\.tagline_cn/.test(EDITOR),
    'the preview does not read the signature the platform answered');
  const at = EDITOR.indexOf('const colShow');
  assert.notStrictEqual(at, -1, 'nothing decides whether to draw the colophon at all');
});

check('the signature route answers a name but never invents a slogan', () => {
  const at = RETAIL_JS.indexOf("router.get('/api/retail-admin/brand/signature'");
  assert.notStrictEqual(at, -1, 'there is no signature route');
  const body = RETAIL_JS.slice(at, at + 1200);
  assert.ok(/brand_name \|\| t\.name/.test(body),
    "a non-Roots tenant is not given its own name");
  assert.ok(/tagline_en: '', tagline_cn: ''/.test(body),
    'a non-Roots tenant is handed a slogan the platform made up');
});

check('the platform answers who has a cast, and answers empty by default', () => {
  const at = RETAIL_JS.indexOf("router.get('/api/retail-admin/brand/signature'");
  assert.notStrictEqual(at, -1, 'there is no characters route');
  const body = RETAIL_JS.slice(at, at + 1400);
  assert.ok(/Number\(t\.id\) === 1/.test(body),
    'the route does not decide by tenant, so it answers the same list to everyone');
  assert.ok(/: \[\]/.test(body), 'a tenant that is not Roots is not answered an empty list');
});

check('an empty cast hides the whole fold, not just the grid', () => {
  const at = EDITOR.indexOf('function paRenderColophonGrid()');
  assert.notStrictEqual(at, -1, 'paRenderColophonGrid has moved');
  const body = EDITOR.slice(at, EDITOR.indexOf('\n}', at));
  assert.ok(/if \(!PA_IP_CHARACTERS\.length\)/.test(body), 'nothing checks for an empty cast');
  assert.ok(/fold\.hidden = true/.test(body),
    'an empty cast leaves two tagline boxes on screen with nothing to explain them');
  assert.ok(/id="pe-acc-colophon" hidden/.test(EDITOR),
    'the fold starts visible, so every shop without a cast sees it flash');
});

console.log(failures ? `\n${failures} check(s) failed.` : `\nAll checks passed.`);
process.exit(failures ? 1 : 0);
