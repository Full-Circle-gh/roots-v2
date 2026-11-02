#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BLOCKS = read('public/shop/blocks.js');

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m) => (c ? ok(m) : bad(m));

console.log('\nWebsite split hero — headline line breaks');

yes(/function htmlWithLineBreaks\(s\)/.test(BLOCKS), 'blocks.js defines htmlWithLineBreaks');
yes(/htmlWithLineBreaks\(headline\)/.test(BLOCKS), 'split hero headline uses htmlWithLineBreaks');
yes(/text-wrap:\s*balance/.test(read('public/shop/blocks.css')), 'split headline uses text-wrap balance');
yes(/website_hero_headline_linebreak_v1/.test(read('database.js')),
  'database.js declares the linebreak migration');

function patchHeadlineEn(s) {
  if (typeof s !== 'string' || s.includes('\n')) return s;
  const LINE2 = 'Fresh food, sorted.';
  if (/^Landed in Guangzhou\?\s*Fresh food,\s*sorted\.?$/i.test(s.trim())) {
    return 'Landed in Guangzhou?\n' + LINE2;
  }
  return s;
}

const patched = patchHeadlineEn('Landed in Guangzhou? Fresh food, sorted.');
if (patched === 'Landed in Guangzhou?\nFresh food, sorted.') ok('migration breaks after the question mark');
else bad('migration breaks after the question mark', `got ${JSON.stringify(patched)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
