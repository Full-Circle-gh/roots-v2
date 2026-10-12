#!/usr/bin/env node
/**
 * §464 — the static half of scripts/test_mobile_sticky_search.js: no browser,
 * so it runs in the fast shard on every change.
 *
 *   node scripts/test_mobile_sticky_search_static.js
 *
 * An inline `position` on a pinned block beats the .stick-top class and kills
 * the pin without anything looking wrong until somebody scrolls. And a pin that
 * quietly disappears in a later edit is the same failure. Both are checked here
 * for every pin in public/m.html.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ── Static: every pin in the file ─────────────────────────────────────── */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'm.html'), 'utf8');
const problems = [];
if (!/\.stick-top\{position:sticky;top:0;z-index:3;background:var\(--bg\)\}/.test(SRC)) {
  problems.push('the .stick-top rule is missing or changed');
}
const tags = SRC.match(/<div class=\\?"stick-top\\?"[^>]*>/g) || [];
if (tags.length < 29) problems.push(`expected at least 29 pinned searches, found ${tags.length}`);
for (const t of tags) {
  if (/position\s*:/.test(t)) problems.push('an inline position beats the class: ' + t.slice(0, 90));
}
if (problems.length) {
  console.error('Static checks failed:');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log(`  ✓ static — ${tags.length} pinned searches, none overridden by an inline position`);
