// The label sheet is written down twice, and the two copies must agree.
//
// WHY THIS FILE EXISTS. ro-query.yml and oneoff.yml each copy exactly ONE file
// to the server — the script named in the dispatch. A sibling data file is not
// staged, and the first run of scripts/diagnose_free_of_sheet.js died on
// precisely that: ENOENT on the .json next to it. So the sheet has to travel
// INSIDE each script that uses it.
//
// That leaves two copies of the same 112 rows: the SHEET_ROWS table inlined in
// the script(s), and scripts/free_of_sheet_2026-09-22.json, which is what the
// office's spreadsheet was actually read into and the thing a reviewer reads.
// Two copies of a list is how a list goes wrong — an edit to one is invisible
// in the other, and a free-of flag is a promise to a shopper with an allergy.
//
// This holds them equal, in the fast shard, so the drift cannot survive a run.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'scripts/free_of_sheet_2026-09-22.json');

// Every script that carries an inlined copy. Add one here when you add one.
const CARRIERS = [
  'scripts/diagnose_free_of_sheet.js',
  'scripts/oneoff_free_of_from_sheet.js',
].filter(p => fs.existsSync(path.join(ROOT, p)));

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, e) => { fail++; console.log('  ✗ ' + m + (e ? '\n      ' + e : '')); };
const check = (m, fn) => { try { fn(); ok(m); } catch (e) { bad(m, e.message); } };

// Pull the SHEET_ROWS array out of a source file without executing it — the
// scripts open a database at require time and must never run here.
function inlineRows(src, where) {
  const at = src.indexOf('const SHEET_ROWS = [');
  assert.ok(at >= 0, `SHEET_ROWS is gone from ${where} — the anchor moved, so this check proves nothing`);
  const open = src.indexOf('[', at);
  let i = open, depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (!depth) break; }
  }
  const body = src.slice(open, i + 1);
  const out = [];
  // ONE entry per line, and the trailing `// Name` comment is dropped FIRST.
  // Two product names in the sheet carry an apostrophe — "Olive 'n' Cream",
  // "Pesto 'Chicken' Wrap" — so a plain quoted-string sweep over the whole
  // array finds 114 strings where there are 112 rows, and blames the wrong one.
  for (const line of body.split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    const m = /'([^']*)'/.exec(code);
    if (m) out.push(m[1]);
  }
  return out;
}

const canon = (sku, flags) => `${sku}|${flags.join(',')}`;

console.log('\nThe inlined sheet matches the .json it was read from');

const sheet = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const expected = sheet.map(r => canon(r.sku, r.free_of));

check('the .json itself has no duplicate SKU', () => {
  const seen = new Set();
  for (const r of sheet) {
    assert.ok(!seen.has(r.sku), `${r.sku} appears twice — which row wins is then luck`);
    seen.add(r.sku);
  }
});

// Only these four exist. Ash, 2026-09-22: "nuts, soy, gluten, 5 spice. - those
// are the one that needed. nothing else, everywhere". A fifth appearing in the
// sheet would be written into the catalogue by the repair without anyone
// deciding it should exist.
const KEEP = new Set(['nuts', 'soy', 'gluten', '5 spice']);
check('the .json names only the four flags that exist', () => {
  for (const r of sheet) {
    for (const t of r.free_of) {
      assert.ok(KEEP.has(t), `"${t}" on ${r.sku} is not one of the four — spelling, or a flag nobody agreed to`);
    }
  }
});

assert.ok(CARRIERS.length, 'no script carries an inlined sheet — nothing to check');
for (const rel of CARRIERS) {
  const got = inlineRows(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel);
  check(`${rel} carries the same ${expected.length} rows, in the same order`, () => {
    assert.strictEqual(got.length, expected.length,
      `${rel} has ${got.length} rows, the .json has ${expected.length}`);
    for (let i = 0; i < expected.length; i++) {
      assert.strictEqual(got[i], expected[i],
        `row ${i + 1}: ${rel} says "${got[i]}", the .json says "${expected[i]}"`);
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
