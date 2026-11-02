#!/usr/bin/env node
'use strict';

/**
 * Brand website hero: "Lunch is sorted" → "Fresh food, sorted." (English only).
 * The live copy lives in storefront_config website.layout; database.js patches
 * it once on boot via website_hero_fresh_food_sorted_v1.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function patchHeadlineEn(s) {
  if (typeof s !== 'string' || !/Lunch is sorted/i.test(s)) return s;
  return s.replace(/Lunch is sorted\.?/gi, 'Fresh food, sorted.');
}

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const eq = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));

console.log('\nWebsite hero — fresh food, sorted');

eq(
  patchHeadlineEn('Landed in Guangzhou? Lunch is sorted.'),
  'Landed in Guangzhou? Fresh food, sorted.',
  'full Yuexiu-style headline',
);
eq(patchHeadlineEn('Lunch is sorted'), 'Fresh food, sorted.', 'headline without question');
eq(patchHeadlineEn('Lunch is sorted.'), 'Fresh food, sorted.', 'headline with trailing period');
eq(patchHeadlineEn('Fresh food, sorted.'), 'Fresh food, sorted.', 'already patched is idempotent');
eq(patchHeadlineEn('Other headline'), 'Other headline', 'unrelated headline untouched');

const yes = (c, m) => (c ? ok(m) : bad(m));
yes(/website_hero_fresh_food_sorted_v1/.test(read('database.js')),
  'database.js declares the one-off migration');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
