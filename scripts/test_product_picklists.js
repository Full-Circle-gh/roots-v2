// §150 — the shop's own entries in the product editor's pick lists.
//
// WHAT THIS SUITE IS REALLY GUARDING. §145 to §149 replaced hand-typing with
// six closed lists, read off the catalogue and decided by most-used-wins. That
// is what makes them trustworthy. Letting a shop ADD to them is the one change
// that can undo it, and there are exactly three ways:
//
//   1. A merge that accumulates. The list is re-merged after every add and
//      every delete, so an entry that is appended without the previous pass
//      being stripped appears twice, then three times.
//   2. A merge that eats a built-in. The strip pass removes everything flagged
//      `custom`; a built-in that ever carries that flag disappears from the
//      product and nothing goes red.
//   3. A list key only one side knows. The editor names the lists and the
//      server holds the allowlist — a name in one and not the other is a row
//      that stores, counts against the cap, and displays nowhere.
//
// All three are silent. Each has a check below.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC    = fs.readFileSync(path.join(ROOT, 'public/product-editor.html'), 'utf8');
const ROUTE  = fs.readFileSync(path.join(ROOT, 'routes/retail-product-picklists.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };
const section = (t) => console.log('\n' + t);

// ── Reading the editor ─────────────────────────────────────────────────────
// Anchors, not line numbers: a check that cannot find what it is about must
// FAIL rather than pass vacuously, which is the trap every suite in this
// family has had to close at least once.
function fnSrc(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name.replace(/[$]/g, '\\$') + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  assert.ok(m, `${name}() not found — the anchor moved, so this check proves nothing`);
  let i = m.index + m[0].length, depth = 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(m.index, i);
}
// `const NAME = <array | object | regex literal>;` out of the page source.
function declSrc(src, name) {
  const head = 'const ' + name + ' = ';
  const at = src.indexOf(head);
  assert.ok(at >= 0, name + ' is gone from the editor');
  const from = at + head.length;
  const open = src[from];
  if (open !== '[' && open !== '{') {                 // a regex literal — one line
    const eol = src.indexOf('\n', from);
    return src.slice(at, eol);
  }
  const shut = open === '[' ? ']' : '}';
  let i = from, depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === shut) { depth--; if (!depth) break; }
  }
  return src.slice(at, i + 1) + ';';
}

// The merge layer, executed rather than grepped. Every list and every function
// it touches, lifted whole out of the page and run in a sandbox.
function editorSandbox() {
  const parts = [
    declSrc(SRC, 'PA_ALLERGENS'),
    declSrc(SRC, 'PA_SPEC_LABELS'),
    declSrc(SRC, 'PA_SPEC_VALUES'),
    declSrc(SRC, 'PA_STORAGE_HEADS'),
    declSrc(SRC, 'PA_STORAGE_UNITS'),
    declSrc(SRC, 'PA_STORAGE_NOTES'),
    declSrc(SRC, '_PA_CUSTOM_TARGETS'),
    declSrc(SRC, 'PA_SPEC_VALUES_KEY_RE'),
    'let PA_CUSTOM_OPTIONS = [];',
    fnSrc(SRC, 'paSpecValuesFor'),
    fnSrc(SRC, 'paSpecValuesKey'),
    fnSrc(SRC, '_paCustomTarget'),
    fnSrc(SRC, '_paEachCustomList'),
    fnSrc(SRC, 'paMergeCustomOptions'),
  ];
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(parts.join('\n\n') + `
    ;globalThis.__api = {
      PA_ALLERGENS, PA_SPEC_LABELS, PA_SPEC_VALUES,
      PA_STORAGE_HEADS, PA_STORAGE_UNITS, PA_STORAGE_NOTES,
      TARGETS: _PA_CUSTOM_TARGETS,
      paMergeCustomOptions, _paCustomTarget, paSpecValuesKey, paSpecValuesFor,
      get options() { return PA_CUSTOM_OPTIONS; },
    };`, ctx);
  return ctx.__api;
}

// ── Reading the server ─────────────────────────────────────────────────────
// The route file is not required: routes/retail.js pulls in the whole retail
// backend and opens a database. The two literals this suite needs are read out
// of the source instead, which also means a rename breaks the check loudly.
function serverFixedKeys() {
  const m = /const FIXED_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(ROUTE);
  assert.ok(m, 'FIXED_KEYS is gone from routes/retail-product-picklists.js');
  return new Set(m[1].split(',').map(s => s.trim()).filter(Boolean)
    .map(s => s.replace(/^['"]|['"]$/g, '')));
}
function serverSpecValuesRe() {
  const m = /const SPEC_VALUES_RE = (\/.*\/);/.exec(ROUTE);
  assert.ok(m, 'SPEC_VALUES_RE is gone from routes/retail-product-picklists.js');
  return new Function('return ' + m[1] + ';')();
}
// One route handler's body, so a check about the ORDER of its guards is about
// the handler and not about the file.
function handler(method, marker) {
  const at = ROUTE.indexOf(`router.${method}('/api/retail-admin/product-picklists${marker}'`);
  assert.ok(at >= 0, `${method.toUpperCase()} ${marker || '/'} handler not found`);
  const next = ROUTE.indexOf('\nrouter.', at + 1);
  return ROUTE.slice(at, next < 0 ? ROUTE.length : next);
}

/* ════════════════════════════════════════════════════════════════════════ */

section('The two sides name the same lists');

check('every fixed key the editor resolves is on the server allowlist', () => {
  const api = editorSandbox();
  const mine = Object.keys(api.TARGETS).sort();
  const theirs = [...serverFixedKeys()].sort();
  assert.deepStrictEqual(mine, theirs,
    `editor ${JSON.stringify(mine)} vs server ${JSON.stringify(theirs)} — ` +
    'a key only one side knows is a row that stores and displays nowhere');
});

check('every fixed key resolves to a real array in the editor', () => {
  const api = editorSandbox();
  for (const k of Object.keys(api.TARGETS)) {
    const t = api._paCustomTarget(k);
    assert.ok(Array.isArray(t), `${k} resolves to ${t}`);
    assert.ok(t.length > 0, `${k} resolves to an empty list — wrong array`);
  }
});

check('an unknown key resolves to nothing rather than a new list', () => {
  const api = editorSandbox();
  assert.strictEqual(api._paCustomTarget('allergen'), null);   // singular typo
  assert.strictEqual(api._paCustomTarget(''), null);
  assert.strictEqual(api._paCustomTarget('storage_heads'), null); // no side
});

check('the spec-values key the editor builds is one the server accepts', () => {
  const api = editorSandbox();
  const re = serverSpecValuesRe();
  for (const label of ['Origin', 'Net Wt', 'Home & Body', 'Product Type', 'Raw · whole', 'Use']) {
    const key = api.paSpecValuesKey(label);
    assert.ok(key, `${label} produced no key`);
    assert.ok(re.test(key), `server would refuse ${JSON.stringify(key)} for ${label}`);
  }
});

check('a label the server would refuse gets no key rather than a doomed save', () => {
  const api = editorSandbox();
  const re = serverSpecValuesRe();
  for (const label of ['', '   ', '<script>', 'x'.repeat(80), 'a\nb']) {
    const key = api.paSpecValuesKey(label);
    if (key) assert.ok(re.test(key), `editor offered ${JSON.stringify(key)} which the server refuses`);
  }
  assert.strictEqual(api.paSpecValuesKey(''), '');
  assert.strictEqual(api.paSpecValuesKey('x'.repeat(80)), '');
});

section('The merge cannot accumulate and cannot eat a built-in');

check('no built-in entry is flagged custom', () => {
  const api = editorSandbox();
  const lists = [
    ['PA_ALLERGENS', api.PA_ALLERGENS],
    ['PA_SPEC_LABELS', api.PA_SPEC_LABELS],
    ['PA_STORAGE_NOTES', api.PA_STORAGE_NOTES],
    ['PA_STORAGE_HEADS.left', api.PA_STORAGE_HEADS.left],
    ['PA_STORAGE_HEADS.right', api.PA_STORAGE_HEADS.right],
    ['PA_STORAGE_UNITS.left', api.PA_STORAGE_UNITS.left],
    ['PA_STORAGE_UNITS.right', api.PA_STORAGE_UNITS.right],
    ...Object.keys(api.PA_SPEC_VALUES).map(k => ['PA_SPEC_VALUES.' + k, api.PA_SPEC_VALUES[k]]),
  ];
  for (const [name, list] of lists) {
    for (const o of list) {
      assert.ok(!o.custom,
        `${name} ships ${JSON.stringify(o.en)} flagged custom — the strip pass would delete it`);
    }
  }
});

check('merging the same rows twice does not double them', () => {
  const api = editorSandbox();
  const before = api.PA_ALLERGENS.length;
  const rows = [{ id: 1, list_key: 'allergens', en: 'Sunflower seeds', cn: '葵花籽' }];
  api.paMergeCustomOptions(rows);
  api.paMergeCustomOptions(rows);
  api.paMergeCustomOptions(rows);
  assert.strictEqual(api.PA_ALLERGENS.length, before + 1);
  assert.strictEqual(api.PA_ALLERGENS.filter(o => o.en === 'Sunflower seeds').length, 1);
});

check('merging an empty set puts every list back exactly as it shipped', () => {
  const fresh = editorSandbox();
  const shipped = JSON.parse(JSON.stringify({
    a: fresh.PA_ALLERGENS, l: fresh.PA_SPEC_LABELS, n: fresh.PA_STORAGE_NOTES,
    h: fresh.PA_STORAGE_HEADS, u: fresh.PA_STORAGE_UNITS, v: fresh.PA_SPEC_VALUES,
  }));
  fresh.paMergeCustomOptions([
    { id: 1, list_key: 'allergens', en: 'Sunflower seeds', cn: '葵花籽' },
    { id: 2, list_key: 'storage_heads.left', en: 'Keep sealed', cn: '密封保存' },
    { id: 3, list_key: 'spec_labels', en: 'Batch', cn: '批次' },
    { id: 4, list_key: 'storage_notes', en: 'Stir before use.', cn: '使用前搅拌。' },
    { id: 5, list_key: 'spec_values:origin', en: 'Sichuan, China', cn: '中国四川' },
  ]);
  fresh.paMergeCustomOptions([]);
  // Compared through JSON, not deepStrictEqual: the lists live in a vm realm
  // and carry that realm's Object.prototype, so reference-equal prototypes is
  // not a property this check is about.
  const same = (a, b, what) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), what);
  same(fresh.PA_ALLERGENS,     shipped.a, 'PA_ALLERGENS did not come back');
  same(fresh.PA_SPEC_LABELS,   shipped.l, 'PA_SPEC_LABELS did not come back');
  same(fresh.PA_STORAGE_NOTES, shipped.n, 'PA_STORAGE_NOTES did not come back');
  same(fresh.PA_STORAGE_HEADS, shipped.h, 'PA_STORAGE_HEADS did not come back');
  same(fresh.PA_STORAGE_UNITS, shipped.u, 'PA_STORAGE_UNITS did not come back');
  same(fresh.PA_SPEC_VALUES.origin, shipped.v.origin, 'PA_SPEC_VALUES.origin did not come back');
});

check('a row duplicating a built-in is dropped, not shown twice', () => {
  const api = editorSandbox();
  const before = api.PA_ALLERGENS.length;
  api.paMergeCustomOptions([
    { id: 1, list_key: 'allergens', en: 'Soy',  cn: '黄豆' },   // exact
    { id: 2, list_key: 'allergens', en: 'soy',  cn: '黄豆' },   // case
    { id: 3, list_key: 'allergens', en: ' Soy ', cn: '黄豆' },  // padded
  ]);
  assert.strictEqual(api.PA_ALLERGENS.length, before,
    'a built-in term was offered a second time with a different Chinese');
  assert.strictEqual(api.PA_ALLERGENS.filter(o => /^\s*soy\s*$/i.test(o.en)).length, 1);
});

check('a row on a list the editor does not know is ignored, not thrown', () => {
  const api = editorSandbox();
  const before = api.PA_ALLERGENS.length;
  api.paMergeCustomOptions([{ id: 9, list_key: 'nonsense', en: 'X', cn: 'X' }]);
  assert.strictEqual(api.PA_ALLERGENS.length, before);
});

section('A value list a shop starts, and can empty again');

check('a label with no built-in list gets one from a custom row', () => {
  const api = editorSandbox();
  assert.strictEqual(api.paSpecValuesFor('Net Wt'), null, 'Net Wt shipped with a list');
  api.paMergeCustomOptions([{ id: 1, list_key: 'spec_values:net wt', en: '250 g', cn: '250 克' }]);
  const list = api.paSpecValuesFor('Net Wt');
  assert.ok(Array.isArray(list) && list.length === 1, 'the list was not created');
  assert.strictEqual(list[0].cn, '250 克');
});

check('removing the last entry leaves no empty dropdown behind', () => {
  const api = editorSandbox();
  api.paMergeCustomOptions([{ id: 1, list_key: 'spec_values:net wt', en: '250 g', cn: '250 克' }]);
  api.paMergeCustomOptions([]);
  assert.strictEqual(api.paSpecValuesFor('Net Wt'), null,
    'an emptied list still reads as a list — the cell would show a <select> ' +
    'offering nothing but "Something else — type it"');
});

check('the match is on the English and is case-insensitive, as it always was', () => {
  const api = editorSandbox();
  api.paMergeCustomOptions([{ id: 1, list_key: 'spec_values:origin', en: 'Sichuan, China', cn: '中国四川' }]);
  assert.ok(api.paSpecValuesFor('origin'));
  assert.ok(api.paSpecValuesFor('ORIGIN'));
  assert.ok(api.paSpecValuesFor('  Origin  '));
});

section('The controls, and where the ＋ is allowed to sit');

check('every list key written into the editor markup is one the server accepts', () => {
  const fixed = serverFixedKeys();
  const re = serverSpecValuesRe();
  const keys = new Set();
  for (const m of SRC.matchAll(/_paCustomBtn\('([^']*)'\)/g)) keys.add(m[1]);
  for (const m of SRC.matchAll(/listKey:\s*'([^']*)'/g)) keys.add(m[1]);
  for (const m of SRC.matchAll(/listKey:\s*`([^`]*)`/g)) {
    // `storage_heads.${which}` — expand the only interpolation these carry.
    for (const w of ['left', 'right']) keys.add(m[1].replace(/\$\{which\}/g, w));
  }
  assert.ok(keys.size >= 5, `only ${keys.size} keys found in the markup — the anchor moved`);
  for (const k of keys) {
    if (!k) continue;                       // the computed spec-values key, checked above
    assert.ok(fixed.has(k) || re.test(k), `the editor offers a ＋ for ${JSON.stringify(k)}, which the server refuses`);
  }
});

check('the ＋ sits beside the allergen chips, never inside one', () => {
  const body = fnSrc(SRC, '_paAllergenChips');
  const add = body.indexOf('_paCustomBtn(');
  const mapEnd = body.indexOf(").join('')");
  assert.ok(add > 0, '_paAllergenChips no longer offers a ＋');
  assert.ok(mapEnd > 0 && add > mapEnd,
    'the ＋ is inside the .map that builds the append-this-term chips — ' +
    'adding a word to the shop and picking one for this product would be one pixel apart');
});

check('the list key never reaches the JS parser from markup', () => {
  const body = fnSrc(SRC, '_paCustomBtn');
  assert.ok(/data-listkey="\$\{escapeAttr\(listKey\)\}"/.test(body),
    'the key is not carried on a data- attribute');
  assert.ok(/onclick="paOpenCustomOptions\(this\.dataset\.listkey\)"/.test(body),
    'the key is interpolated into the onclick — a spec-values key carries the ' +
    'OPERATOR-TYPED label, so a label with an apostrophe closes the string ' +
    'literal as soon as the HTML parser decodes &#39; back to \'');
  assert.ok(!/paOpenCustomOptions\('\$\{/.test(body), 'the key is still inlined into the handler');
});

check('a blank list key renders no button at all', () => {
  const body = fnSrc(SRC, '_paCustomBtn');
  assert.ok(/if\s*\(!listKey\)\s*return\s*''/.test(body),
    '_paCustomBtn does not refuse a blank key — a spec-strip cell with no label ' +
    'would offer a save the server 400s');
});

check('the refresh syncs the DOM before it re-renders', () => {
  const body = fnSrc(SRC, 'paRefreshAfterCustomOptions');
  const sync = body.indexOf('paBlocksSyncFromDOM()');
  const draw = body.indexOf('paRenderDoc()');
  assert.ok(sync > 0 && draw > 0, 'the anchors moved');
  assert.ok(sync < draw,
    'paRenderDoc runs before the sync — it rebuilds every section from the model, ' +
    'so anything typed and not yet synced is painted over (§145\'s ordering bug)');
});

check('the shop\'s options are loaded on mount', () => {
  assert.ok(/paLoadCustomOptions\(\);/.test(SRC), 'paLoadCustomOptions is never called');
  const mount = SRC.indexOf('paLoadCustomTemplates();   // async');
  assert.ok(mount > 0, 'the mount anchor moved');
  assert.ok(SRC.slice(mount, mount + 400).includes('paLoadCustomOptions()'),
    'the options are not fetched beside the templates on mount');
});

check('a failed fetch leaves the built-in lists working', () => {
  const body = fnSrc(SRC, 'paLoadCustomOptions');
  assert.ok(/catch\s*\(/.test(body), 'paLoadCustomOptions has no catch — one 404 and the editor stops');
  assert.ok(/if\s*\(!r\.ok\)\s*return/.test(body), 'a non-2xx response is not handled');
});

section('The server refuses what would corrupt a list');

check('an unknown list key is refused before anything is written', () => {
  const h = handler('post', '');
  const guard = h.indexOf('bad_list_key');
  const insert = h.indexOf('INSERT INTO');
  assert.ok(guard > 0 && insert > 0, 'the anchors moved');
  assert.ok(guard < insert, 'the key is validated after the insert');
});

check('both languages are required', () => {
  const h = handler('post', '');
  assert.ok(h.includes('both_languages_required'), 'a half-filled pair can be saved');
  const guard = h.indexOf('both_languages_required');
  assert.ok(guard < h.indexOf('INSERT INTO'), 'the guard is after the insert');
});

check('the per-list cap is counted before the insert', () => {
  const h = handler('post', '');
  const count = h.indexOf('SELECT COUNT(*)');
  const full = h.indexOf('list_full');
  const insert = h.indexOf('INSERT INTO');
  assert.ok(count > 0 && full > 0 && insert > 0, 'the anchors moved');
  assert.ok(count < insert && full < insert, 'the cap is checked after the insert');
});

check('duplicates are refused case-insensitively', () => {
  const h = handler('post', '');
  assert.ok(/WHERE list_key = \? AND en = \? COLLATE NOCASE/.test(h),
    'the duplicate check is case-sensitive — Soy and soy would both be offered');
});

check('every query goes through the tenant connection', () => {
  const calls = ROUTE.match(/\b(?:tdb\(\)|db)\.prepare\(/g) || [];
  assert.ok(calls.length >= 4, `only ${calls.length} prepared statements found — the anchor moved`);
  for (const c of calls) {
    assert.ok(c.startsWith('tdb()'),
      'a query uses the shared global db — that is a cross-tenant read/write leak');
  }
});

check('the route is mounted', () => {
  assert.ok(SERVER.includes("require('./routes/retail-product-picklists')"),
    'the router exists and nothing serves it');
});

section('The table');

check('retail_product_picklists is created with the columns the route writes', () => {
  const m = /CREATE TABLE IF NOT EXISTS retail_product_picklists \(([\s\S]*?)\)`\);/.exec(SCHEMA);
  assert.ok(m, 'the table is not in database.js');
  for (const col of ['list_key', 'en', 'cn', 'created_by', 'created_at']) {
    assert.ok(new RegExp('\\b' + col + '\\b').test(m[1]), `${col} is missing`);
  }
});

check('one spelling per list, enforced by the index and not only by the route', () => {
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_product_picklists_key_en[\s\S]*?list_key, en COLLATE NOCASE/.test(SCHEMA),
    'nothing stops two rows spelling one term two ways — two clients racing ' +
    'the SELECT-then-INSERT would both pass the duplicate check');
});

section('The editor still parses');

check('every inline <script> in the product editor is valid JavaScript', () => {
  const blocks = [...SRC.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length > 0, 'no inline script found — the anchor moved');
  blocks.forEach((b, i) => {
    try { new vm.Script(b[1]); }
    catch (e) { throw new Error(`inline script #${i + 1} does not parse: ${e.message}`); }
  });
});

/* ════════════════════════════════════════════════════════════════════════ */

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
