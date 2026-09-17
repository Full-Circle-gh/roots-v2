// The product page editor does not lose the office's work, does not lie about
// a failure, and does not hand an id it was given to the JS parser.
//
// WHY THIS FILE EXISTS. public/product-editor.html is one 4,400-line page with
// no module boundary and no runtime test around it, so every guard in it is a
// line somebody could delete without anything going red. The audit that
// produced these fixes found four ways to lose an unsaved design, two failures
// that painted in the success colour, and three ids interpolated into inline
// handlers as JavaScript source. Each one had been correct at some point in a
// sibling function and wrong here — which is what a test is for.
//
// THESE ARE SOURCE ASSERTIONS, like test_product_editor_tacet.js beside them.
// The page needs a DOM to run and the fast shard has no browser, so each check
// first proves its ANCHOR is present and then proves the property holds at it.
// A rename therefore fails this file loudly rather than passing it vacuously —
// an assertion that can only ever match nothing is worse than no assertion.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/product-editor.html'), 'utf8');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

// The body of a top-level `function name(...) { ... }`, by brace balance.
// Returns '' when the function is not there, so a caller asserting on its
// contents fails on the anchor rather than on an empty string that matches
// nothing it was looking for.
function fnBody(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) return '';
  let i = m.index + m[0].length, depth = 1;
  for (; i < SRC.length && depth > 0; i++) {
    const c = SRC[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return SRC.slice(m.index, i);
}
const anchored = (name) => {
  const b = fnBody(name);
  assert.ok(b, `${name}() not found — the anchor moved, so this check proves nothing`);
  return b;
};

// ── 1. Unsaved work never leaves without a question ─────────────────────
section('Unsaved work');

check('a beforeunload listener guards the exits the page does not own', () => {
  const m = /addEventListener\('beforeunload',\s*\(e\)\s*=>\s*\{([\s\S]*?)\n\}\);/.exec(SRC);
  assert.ok(m, 'no beforeunload listener — tab close and reload drop the design silently');
  assert.ok(/peIsDirty\(\)/.test(m[1]), 'beforeunload does not consult peIsDirty()');
  assert.ok(/e\.preventDefault\(\)/.test(m[1]) && /returnValue/.test(m[1]),
    'beforeunload must both preventDefault and set returnValue or Chrome shows nothing');
});

check('the page\'s own navigations suppress that prompt so it never double-asks', () => {
  assert.ok(/function peLeaveIntentionally\(\)/.test(SRC), 'no peLeaveIntentionally()');
  const m = /addEventListener\('beforeunload',\s*\(e\)\s*=>\s*\{([\s\S]*?)\n\}\);/.exec(SRC);
  assert.ok(/_peLeaving/.test(m[1]), 'beforeunload ignores the deliberate-exit flag');
  // Every location.href / window.close in the page's own code sets it first.
  for (const fn of ['fcGotoMiniApp', 'peClose', 'peSwitchProduct']) {
    assert.ok(/peLeaveIntentionally\(\)/.test(anchored(fn)),
      `${fn}() navigates away without flagging the exit — the browser asks a second time`);
  }
});

check('peClose asks before discarding, like every other exit', () => {
  const b = anchored('peClose');
  assert.ok(/peIsDirty\(\)/.test(b), 'peClose does not check for unsaved changes');
  assert.ok(/askConfirm\(/.test(b), 'peClose does not ask');
});

check('paSaveEdit reports its verdict instead of swallowing it', () => {
  const b = anchored('paSaveEdit');
  assert.ok(/\breturn true;/.test(b), 'paSaveEdit never reports success');
  assert.ok(/\breturn false;/.test(b), 'paSaveEdit never reports failure');
});

check('fcGotoMiniApp stays put when that save failed', () => {
  const b = anchored('fcGotoMiniApp');
  assert.ok(!/try\s*\{\s*await paSaveEdit\(\);?\s*\}\s*catch/.test(b),
    'a try/catch around paSaveEdit always falls through — it catches its own errors and never throws');
  assert.ok(/await paSaveEdit\(\)/.test(b) && /if \(!saved\) return;/.test(b),
    'fcGotoMiniApp navigates without reading the save verdict');
});

// ── 2. A failure looks like a failure ───────────────────────────────────
section('Error paths');

check("toast() is never called with a kind it does not know", () => {
  const t = anchored('toast');
  assert.ok(/kind === 'err'/.test(t), "toast's error kind is no longer 'err' — update this check");
  const strays = SRC.match(/toast\([^;]*?,\s*'error'\s*\)/g) || [];
  assert.deepStrictEqual(strays, [],
    `toast(..., 'error') paints in the SUCCESS colour — toast only tests for 'err': ${strays.join(' | ')}`);
});

check('the media upload handles a lost session and a non-JSON body', () => {
  const b = anchored('paImageBandUpload');
  assert.ok(/status === 401 \|\| \w+\.status === 403/.test(b),
    'an expired session during upload reads as a generic "Upload failed"');
  assert.ok(/peAuthBail\(\)/.test(b), 'upload does not bounce on a lost session');
  assert.ok(/\.json\(\)\.catch\(/.test(b),
    'an unguarded .json() throws on a proxy error page (413, gateway HTML)');
});

check('peBoot checks BOTH responses for a lost session', () => {
  const b = anchored('peBoot');
  assert.ok(/listRes\.status === 401 \|\| listRes\.status === 403/.test(b),
    'the catalog list response is not checked for 401/403');
});

check('switching to a product missing from the stale cache is not a dead end', () => {
  const b = anchored('peSwitchProduct');
  assert.ok(!/const p = PA_ALL_PRODUCTS\.find\([^)]*\);\s*\n\s*if \(!p\) return;/.test(b),
    'a bare return on a cache miss is a click that does nothing and says nothing');
  assert.ok(/Number\.isFinite\(id\)/.test(b), 'a non-numeric id still reaches the fetch URL');
});

// ── 3. An id is data, never source ──────────────────────────────────────
section('Ids that come from outside');

check('block ids are sanitised where they enter, not escaped at each use', () => {
  assert.ok(/function paSafeBlockId\(id\)/.test(SRC), 'no paSafeBlockId()');
  const b = anchored('peMount');
  assert.ok(/paSafeBlockId\(/.test(b),
    'peMount trusts the id stored in description_blocks JSON, which lands in onclick= as source');
  assert.ok(!/id: b\.id \|\| paBlocksGenId\(\)/.test(SRC),
    'the old unchecked "keep whatever id was stored" is still there');
});

check('template ids reach their handlers as data attributes', () => {
  const b = anchored('paRenderPresets');
  assert.ok(/data-tpl="\$\{escapeAttr\(p\.id\)\}"/.test(b),
    'the template id is not carried as an escaped data attribute');
  assert.ok(!/paOpenTemplatePreview\('\$\{p\.id\}'\)/.test(b) &&
            !/paDeleteCustomTemplate\(event, '\$\{p\.id\}'\)/.test(b),
    'an operator-supplied template id is still interpolated into JS source inside an inline handler');
  assert.ok(/this\.dataset\.tpl/.test(b), 'the handlers do not read the id back from dataset');
});

check('a template id in a CSS class name is stripped, everywhere it is used', () => {
  assert.ok(/function paTplClass\(id\)/.test(SRC), 'no paTplClass()');
  for (const fn of ['paThumbHtml', 'paOpenTemplatePreview']) {
    assert.ok(/paTplClass\(/.test(anchored(fn)), `${fn}() builds a pa-tpl- class from a raw id`);
  }
  assert.ok(/pa-tpl-\$\{paTplClass\(p\.id\)\}/.test(anchored('paRenderPresets')),
    "the chooser card's own pa-tpl- class still takes the raw id");
});

check('a template with no block stack cannot be applied', () => {
  const a = anchored('paApplyTemplate');
  assert.ok(/Array\.isArray\(tpl\.blocks\)/.test(a),
    'paApplyTemplate calls .map on a blocks array it never checked');
  const p = anchored('paOpenTemplatePreview');
  assert.ok(/nBlocks/.test(p) && /useBtn\.disabled = isCur \|\| !nBlocks/.test(p),
    'the Use button is offered for a template that would do nothing');
});

check('an imported template with no descriptions gets no tooltip, not "undefined"', () => {
  const b = anchored('paRenderPresets');
  assert.ok(!/escapeHtml\(p\.desc_en \+ ' · ' \+ p\.desc_cn\)/.test(b),
    'joining two possibly-absent descriptions prints "undefined · undefined"');
  assert.ok(/\[p\.desc_en, p\.desc_cn\]/.test(b), 'the descriptions are not filtered before joining');
});

// ── 4. Work the page does not need to do ────────────────────────────────
section('Efficiency');

check('the phone preview is not rebuilt on every keystroke', () => {
  const b = anchored('paLivePreview');
  assert.ok(/_paPreviewTimer/.test(b) && /setTimeout\(paRenderPreview/.test(b),
    'paLivePreview rebuilds the whole preview synchronously per input event');
  assert.ok(/paBlocksSyncFromDOM\(\)/.test(b),
    'the block state must stay immediate — peIsDirty and paSaveEdit both read it');
  assert.ok(/clearTimeout\(_paPreviewTimer\)/.test(anchored('paRenderPreview')),
    'a direct render leaves the queued one to paint the same page again');
});

check('nothing renders the preview twice in a row', () => {
  const pairs = SRC.match(/paRenderAll\(\);\s*\n\s*paLivePreview\(\);/g) || [];
  assert.deepStrictEqual(pairs, [],
    'paRenderAll() already ends in paRenderPreview() — the paLivePreview() after it repaints everything a second time');
});

check('the i18n registry lets go of nodes the preview replaced', () => {
  assert.ok(/function pruneReg\(\)/.test(SRC), 'no pruneReg()');
  assert.ok(/if \(_reg\.length > \d+\) pruneReg\(\);/.test(SRC),
    'the registry is only swept when somebody toggles the language, so it grows for the session');
});

check('the auto draft remembers every product it has already composed', () => {
  assert.ok(/_peAutoFilledFor = new Set\(\)/.test(SRC),
    'a single remembered id means switching away and back fires a second AI compose');
  const b = anchored('peDraftEmptySections');
  assert.ok(/_peAutoFilledFor\.has\(p\.id\)/.test(b) && /_peAutoFilledFor\.add\(p\.id\)/.test(b),
    'peDraftEmptySections does not use the set');
  // The memory is the AUTO path's alone. A pressed button that could only be
  // pressed once per product per session is not a retry, which is the whole
  // reason the control exists (§154).
  assert.ok(/if \(auto && _peAutoFilledFor\.has\(p\.id\)\) return;/.test(b),
    'the once-per-session guard must be gated on `auto` or the button cannot be pressed twice');
});

// §154. The old code joined the set before the network call and NEVER LEFT IT,
// so one failed pass meant that product got no draft for the rest of the
// session and nothing on screen ever said why. The mark still has to be taken
// before the request goes out — two mounts in quick succession would otherwise
// both fire — so the fix is the other half: the failure path gives it back.
check('a failed draft does not burn the product for the session', () => {
  const b = anchored('peDraftEmptySections');
  const marked = b.indexOf('_peAutoFilledFor.add(p.id)');
  const fetched = b.indexOf("fetch('/api/retail-admin/ai/compose-blocks'");
  assert.ok(marked > 0 && fetched > 0, 'the draft no longer marks, or no longer composes');
  assert.ok(marked < fetched,
    'the mark is taken after the request goes out, so a second mount can fire a duplicate compose');
  assert.ok(/_peAutoFilledFor\.delete\(p\.id\)/.test(b),
    'nothing gives the id back on failure, so one bad pass silences the product for the session');
  // The give-back has to be ON the failure path, not somewhere it always runs.
  const cat = b.slice(b.lastIndexOf('} catch'));
  assert.ok(/_peAutoFilledFor\.delete\(p\.id\)/.test(cat),
    'the id is handed back outside the catch — then a SUCCESSFUL draft re-fires on the next mount too');
});

// §154. The editor is handed product_facts and `weight AS size` in the very
// response it mounts from, and routes/ai.js reads both as the source of truth
// for the spec strip, storage, ingredients and how-to-use. Sending only the
// name and category is what made the editor's design worse than the sheet's.
check('every compose call sends the facts and the weight this editor is holding', () => {
  const ctx = anchored('peComposeProduct');
  for (const key of ['facts:', 'weight:', 'category:']) {
    assert.ok(ctx.includes(key), `peComposeProduct omits ${key} — the prompt reads it by that name`);
  }
  assert.ok(/PA_CURRENT\.product_facts/.test(ctx) && /PA_CURRENT\.size/.test(ctx),
    'the context is not built from the mounted product, so it cannot carry what the mount fetched');
  // Both callers, not one: a second hand-rolled payload is a second answer.
  const calls = SRC.match(/compose-blocks'[\s\S]{0,700}?\}\),/g) || [];
  assert.ok(calls.length >= 2, `expected the draft and Smart paste to both compose, found ${calls.length}`);
  const thin = calls.filter(c => !/product: peComposeProduct\(\)/.test(c));
  assert.deepStrictEqual(thin, [],
    `a compose call building its own product context:\n${thin.join('\n---\n')}`);
});

// §154's one rule. A draft that can overwrite a written section is the "rebuild
// replaces the page" trap wearing a new label.
check('a drafted section never lands on one that already carries words', () => {
  const b = anchored('peDraftEmptySections');
  assert.ok(/peFilledTypes\(\)/.test(b), 'nothing asks which types are already written');
  assert.ok(/!filled\.has\(b\.type\)/.test(b),
    'the composed blocks are not filtered against what the page already says');
  const f = anchored('peFilledTypes');
  assert.ok(/_paBlockHasWords\(b\)/.test(f),
    'filled-ness must be measured by the same predicate the save uses, not by presence');
  // Measured AFTER the call returns: the office may have typed while it flew.
  const filt = b.indexOf('const filled = peFilledTypes();');
  const resp = b.indexOf('await r.json()');
  assert.ok(filt > resp && resp > 0,
    'the page is read before the request goes out, so words typed during the call would be overwritten');
});

// ── 5. One language at a time, on every control ─────────────────────────
section('Bilingual chrome');

check('every confirm dialog labels its button in the reader\'s language', () => {
  const calls = SRC.match(/askConfirm\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(calls.length >= 5, `expected the page's askConfirm calls, found ${calls.length}`);
  const english = calls.filter(c =>
    !/confirmCn:/.test(c) && !/confirmLabel: cuT\(/.test(c));
  assert.deepStrictEqual(english, [],
    `a dialog that asks in 中文 and answers in English only:\n${english.join('\n---\n')}`);
});

check('cuT is never handed the same string for both languages', () => {
  const dup = [];
  for (const m of SRC.matchAll(/cuT\('((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\)/g)) {
    if (m[1] === m[2]) dup.push(m[0]);
  }
  assert.deepStrictEqual(dup, [],
    `cuT(x, x) prints BOTH languages whichever one is chosen, beside siblings that print one:\n${dup.join('\n')}`);
});

check('the three product lists say "no match" the same way', () => {
  const variants = new Set();
  for (const m of SRC.matchAll(/cuLang\(\) === 'cn' \? '没有匹配的产品。'|cuT\('No products match\.',\s*'没有匹配的产品。'\)/g)) {
    variants.add(m[0].startsWith('cuT') ? 'cuT' : 'ternary');
  }
  assert.deepStrictEqual([...variants], ['cuT'],
    'the switcher, the left rail and the cold-start picker do not agree on how to say it');
});

// ── 6. The preview never draws a broken image ───────────────────────────
section('Preview');

check('the colophon portrait hides itself when the asset is missing', () => {
  const b = anchored('paRenderPreview');
  const m = /<img class="pa-prev-colophon-img"[^>]*>/.exec(b);
  assert.ok(m, 'the colophon portrait is no longer rendered here — update this check');
  assert.ok(/onerror=/.test(m[0]),
    'the live preview draws a broken-image glyph where its own sample-screen twin hides it');
  assert.ok(/encodeURIComponent\(colResChar\)/.test(m[0]),
    'the character key goes into a src attribute unescaped');
});

// ── 7. The save predicate, RUN rather than read ─────────────────────────
//
// Everything above is a source assertion because the page needs a DOM. This
// section does not: _paBlockWillSave and _paBlockHasWords are pure functions of
// one block object, so they are lifted out of the page and CALLED. A grep can
// only say the predicate is still spelled the same; these say what it decides.
section('What the save actually keeps (functions executed, not grepped)');

const PRED = (() => {
  const parts = ['_paBlockWillSave', '_paBlockHasWords'].map(anchored);
  const constRe = /const _PA_NOT_WORDS = new Set\(\[[\s\S]*?\]\);/;
  const m = constRe.exec(SRC);
  assert.ok(m, '_PA_NOT_WORDS not found — the predicate moved');
  return new Function(`${m[0]}\n${parts.join('\n')}\nreturn { _paBlockWillSave, _paBlockHasWords };`)();
})();
const willSave = PRED._paBlockWillSave;
const hasWords = PRED._paBlockHasWords;
// What the stack marks and the save toast counts: written into, still dropped.
const marked = (b) => !willSave(b) && hasWords(b);

check('an untouched section is dropped, and is NOT worth interrupting for', () => {
  const blank = { id: 'b1', type: 'hero_intro', kicker_en: '', kicker_cn: '', body_en: '',
                  body_cn: '', highlight_en: '', highlight_cn: '' };
  assert.strictEqual(willSave(blank), false, 'an empty hero_intro should not be persisted');
  assert.strictEqual(marked(blank), false, 'a section nobody typed into must not be flagged — it is noise');
});

check('a question with no answer is flagged, not silently binned', () => {
  const faq = { id: 'b2', type: 'faq', title_en: '', title_cn: '',
                items: [{ q_en: 'Is it spicy?', q_cn: '', a_en: '', a_cn: '' }] };
  assert.strictEqual(willSave(faq), false, 'the completeness rule is unchanged: half an FAQ is not shown');
  assert.strictEqual(marked(faq), true, 'the words typed into it must be flagged before the save drops them');
});

check('a complete question is kept', () => {
  const faq = { id: 'b3', type: 'faq',
                items: [{ q_en: 'Is it spicy?', q_cn: '', a_en: 'Mild.', a_cn: '' }] };
  assert.strictEqual(willSave(faq), true);
  assert.strictEqual(marked(faq), false);
});

check('the other four ways to lose words are all flagged', () => {
  const cases = {
    'image band with a caption but no photo':
      { id: 'c1', type: 'image_band', url: '', caption_en: 'Stone-ground in Yunnan', ratio: 'wide' },
    'recipe steps with a title and no steps':
      { id: 'c2', type: 'recipe_steps', title_en: 'How we make it', steps: [{ text_en: '', text_cn: '' }] },
    'cross-sell with a title and no products':
      { id: 'c3', type: 'pairings', title_en: 'Goes well with', items: [] },
    'a usage tile with a note but no label':
      { id: 'c4', type: 'how_to_use', tiles: [{ icon: '', label_en: '', label_cn: '', sub_en: 'over warm oats', sub_cn: '' }] },
  };
  for (const [what, b] of Object.entries(cases)) {
    assert.strictEqual(willSave(b), false, `${what}: the rule changed — re-read this test`);
    assert.strictEqual(marked(b), true, `${what}: written into, dropped, and NOT flagged`);
  }
});

check('a setting is not a word — colours and flags never flag a row', () => {
  for (const b of [
    { id: 'd1', type: 'hero_intro', body_en: '', bg_color: 'lime-leaf', fg_color: 'ink', accent_color: 'berry-punch' },
    { id: 'd2', type: 'hero_intro', body_en: '', hide_qr: true },
    { id: 'd3', type: 'image_band', url: '', ratio: 'wide', caption_en: '' },
    { id: 'd4', type: 'how_to_use', tiles: [{ icon: '', label_en: '', sub_en: '' }] },
  ]) {
    assert.strictEqual(marked(b), false,
      `a block carrying only settings was flagged as unsaved work: ${JSON.stringify(b)}`);
  }
});

check('the seeded sections a template lays down are all saved as-is', () => {
  // Every make()/template default that ships with prefilled copy must pass, or
  // adding one from the dropdown would flag itself the moment it appeared.
  const seeded = [
    { id: 'e1', type: 'spec_strip', cells: [{ k_en: 'Type', k_cn: '类型', v_en: '', v_cn: '' }] },
    { id: 'e2', type: 'storage_box',
      left:  { icon: '🌡', head_en: 'Unopened', head_cn: '未开封', num_en: 'Cool & dry' },
      right: { icon: '❄', head_en: 'After opening', head_cn: '开封后', num_en: 'Refrigerate' },
      note_en: 'Stir before each use.', note_cn: '每次使用前请搅拌。' },
    { id: 'e3', type: 'nutrition_facts', basis_en: 'Per 100g', basis_cn: '每100克',
      rows: [{ label_en: 'Energy', label_cn: '能量', value: '' }] },
  ];
  for (const b of seeded) {
    assert.strictEqual(willSave(b), true, `a freshly added ${b.type} would be dropped on the first save`);
    assert.strictEqual(marked(b), false, `a freshly added ${b.type} flags itself as unfinished`);
  }
});

check('an unknown block type is kept rather than quietly discarded', () => {
  assert.strictEqual(willSave({ id: 'f1', type: 'something_new', text_en: 'hi' }), true,
    'a type this build does not know must survive a round-trip, not be deleted by it');
});

check('the marker is recomputed on the typing path, not only on a full rebuild', () => {
  /* §144 retired paRefreshTabLabels with the section list it repainted. The
     reason the check exists did not retire with it: a marker that is only
     decided on a full rebuild stays on a section for the rest of the session
     after the missing answer is typed, and the office learns to ignore it. */
  const b = anchored('paDocRefreshMarks');
  assert.ok(/_paBlockWillSave\(b\)/.test(b) && /_paBlockHasWords\(b\)/.test(b),
    'paDocRefreshMarks does not re-decide the marker from the same predicate');
  assert.ok(/\.remove\(\)/.test(b), 'the marker is never cleared once set');
  const live = anchored('paLivePreview');
  assert.ok(/paDocRefreshMarks\(\)/.test(live),
    'the typing path never calls it, so the marker only moves on a full repaint');
});

check('the save reports the count in the failure colour, from the same predicate', () => {
  const b = anchored('paSaveEdit');
  assert.ok(/paUnsavableBlocks\(\)\.length/.test(b),
    'paSaveEdit does not count what it is about to drop');
  assert.ok(/'err'\);/.test(b.slice(b.indexOf('unsavable'))),
    'a save that dropped written-in sections still reports in the success colour');
  assert.ok(b.indexOf('const unsavable') < b.indexOf('peCollectBody()'),
    'counted after collect, when there is nothing left to count');
});

check('one predicate, two readers — the list and the save cannot disagree', () => {
  const collect = anchored('paBlocksCollect');
  assert.ok(/return _paBlockWillSave\(b\);/.test(collect),
    'paBlocksCollect carries its own copy of the rule again');
  assert.ok(!/b\.type === 'faq'/.test(collect),
    'the per-type tests are back inside the filter, where nothing else can ask them');
});

// ── 8. The badge speaks for one surface and names it ────────────────────
section('The badge, and the publish control it never had');

check('nothing on the page calls this product a draft any more', () => {
  // "Draft · 草稿" claims nobody can see the product. A shop listing can have it
  // on a counter menu while is_published is 0 — the two gates are separate by
  // ruling (§42) — so the word was wrong on exactly the products it mattered on.
  const code = SRC.replace(/\/\/[^\n]*/g, '');   // the decision is recorded in comments
  assert.ok(!/'草稿'/.test(code), "the Draft badge is back somewhere in the page's code");
  assert.ok(/cuT\('Hidden', '未上架'\)/.test(code),
    "the catalogue's own pair for this flag is not being used");
});

check('the online-store pill says WHICH surface, in live strings only', () => {
  const b = anchored('peRenderBadges');
  assert.ok(/_peBadgePair\('Online store', '线上商城'/.test(b),
    'the pill does not name the surface it speaks for');
  assert.ok(/'Live' : 'Hidden'/.test(b) && /'已上架' : '未上架'/.test(b),
    'the state is not the catalogue pair');
  // 已上架线上商城 would be a phrase MINTED by sticking two live terms together.
  // The middot joins them instead, which is what 09-products.js already does.
  assert.ok(!/已上架线上商城|未上架线上商城|已下架线上商城/.test(SRC),
    'a compound Chinese phrase was minted out of two live terms — join them with · instead');
});

check('the badge is a control, and it publishes the whole variant family', () => {
  assert.ok(/<button type="button" id="pe-badge"[^>]*onclick="peTogglePublish\(\)"/.test(SRC),
    'the badge is not pressable — the editor still has no way to publish');
  const t = anchored('peTogglePublish');
  assert.ok(/peFamilyIds\(\)/.test(t), 'publishing one size leaves its siblings behind');
  const f = anchored('peFamilyIds');
  assert.ok(/variant_group_id/.test(f), 'the family is not resolved by variant group');
  assert.ok(/is_published: val/.test(t), 'the toggle does not write the flag the storefront filters on');
});

check('publishing saves first, and abandons the publish if that save failed', () => {
  const t = anchored('peTogglePublish');
  assert.ok(/turningOn && peIsDirty\(\)/.test(t),
    'publishing with unsaved edits puts the LAST SAVED page in front of customers');
  assert.ok(/const saved = await paSaveEdit\(\);\s*\n\s*if \(!saved\) return;/.test(t),
    'the publish goes ahead on a failed save');
  assert.ok(t.indexOf('turningOn &&') > 0 && /turningOn && peIsDirty/.test(t),
    'hiding a page needs no save — taking it down never shows the wrong one');
});

check('a failed publish puts the switch back rather than lying', () => {
  const t = anchored('peTogglePublish');
  assert.ok(/apply\(val \? 0 : 1\)/.test(t), 'a failed PATCH leaves the pill claiming the wrong state');
  assert.ok(/peAuthBail\(\)/.test(t), 'a lost session during publish is not handled');
});

check('the QR pill reports and never pretends to be a control', () => {
  const b = anchored('peRenderBadges');
  assert.ok(/_peBadgePair\('QR menu', '二维码菜单'/.test(b),
    "the second pill does not use this page's own QR-menu pair");
  assert.ok(/tenant_has_shops/.test(b),
    'a business with no shops still gets a "QR menu 0" on every product');
  assert.ok(/filter\(x => x\.reachable\)/.test(b),
    'a listing at a switched-off shop is counted as somewhere a customer can see it');
  assert.ok(/<span id="pe-shops-badge"/.test(SRC) && !/id="pe-shops-badge"[^>]*onclick/.test(SRC),
    'the QR pill is clickable — adding a product to a menu is the shop screen\'s job');
});

check('the editor asks the shops route and never names the table', () => {
  assert.ok(/\/api\/retail-admin\/products\/' \+ id \+ '\/shops'/.test(anchored('peLoadShopListings')),
    'peLoadShopListings does not call the route');
  // scripts/test_shop_listings.js walks public/ for this name. A reader here
  // would have widened a containment guard that is deliberately narrow.
  assert.ok(!/shop_listings/.test(SRC),
    'the editor names shop_listings — that widens the containment allowlist for nothing');
});

check('a slow answer for a product you already switched away from is dropped', () => {
  const b = anchored('peLoadShopListings');
  assert.ok(/_peShopsFor !== id/.test(b),
    'an in-flight fetch can paint the previous product\'s shop count onto this one');
});

check('the tooltip is repainted when the language changes', () => {
  // It is the one bilingual string on the badge that lives in an attribute,
  // which the text-node rewriter cannot reach.
  assert.ok(/typeof peRenderBadges === 'function'\) peRenderBadges\(\)/.test(SRC),
    'switching language leaves the badge tooltip in the old one');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
