#!/usr/bin/env node
// Every toggleable feature must have somewhere to be toggled.
//
// WHY THIS SUITE EXISTS. `waste` shipped in FEATURE_CATALOG with no
// FEATURE_HOMES entry, so mountFeatureControls() never visited it and its
// switch mounted nowhere — the feature was on by the server default in
// routes/retail-waste.js and that was the only state it ever had. Nothing
// failed. No page threw, no console error, no test went red: a feature that
// cannot be turned off looks exactly like a feature nobody has turned off.
// The Settings list said otherwise, which is the part that costs trust.
//
// It takes THREE files agreeing to mount one switch — the catalog key
// (02-settings-ops.js), the home selector (05-marketing.js) and the host div
// (retail-admin.html) — and any one of the three missing is silent. So the
// agreement is asserted here rather than left to whoever adds the next one.
//
// AN EXEMPTION IS A NAMED PLACE, NOT A HOLE. A feature may own its switch
// somewhere else; `affiliate` does. It is listed below with the file that
// writes its config key, and that claim is checked too — an exemption nobody
// verifies is the same silence in a nicer shape.
//
// Run:  node scripts/test_feature_switches_mount.js
//
// Cases:
//   1. every catalog key has a home, or a named and verified exemption
//   2. every home selector resolves to a host that exists in the markup
//   3. no home points at a key the catalog does not carry
//   4. the exemptions still hold — the file named still writes that key

'use strict';

const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); }
                            else { fail++; console.log('  ✗ ' + msg); } };

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const settingsSrc  = read('public', 'retail-admin', '02-settings-ops.js');
const marketingSrc = read('public', 'retail-admin', '05-marketing.js');
const html         = read('public', 'retail-admin.html');

// A feature whose switch lives somewhere other than FEATURE_HOMES. The value is
// the file that writes its `features.<key>` config, which case 4 checks.
const EXEMPT = {
  affiliate: 'public/retail-admin/10-extras.js',   // the Affiliate page's own program card
};

// ── parse the three sources ───────────────────────────────────────────────
function block(src, opener) {
  const i = src.indexOf(opener);
  if (i < 0) return '';
  return src.slice(i, src.indexOf('\n];', i) >= 0 ? src.indexOf('\n];', i)
                                                  : src.indexOf('\n};', i));
}
const catalog = block(settingsSrc, 'const FEATURE_CATALOG = [');
const homes   = block(marketingSrc, 'const FEATURE_HOMES = {');

const KEYS  = [...catalog.matchAll(/\{\s*key:\s*'([A-Za-z_]\w*)'/g)].map(m => m[1]);
// Only the real entries, not the keys named inside the comments that explain
// why something is absent — a mapping line is `key: '#selector'`.
const HOMES = Object.fromEntries(
  [...homes.matchAll(/^\s{2}([A-Za-z_]\w*):\s*'(#[\w-]+)'/gm)].map(m => [m[1], m[2]]));

console.log('\n══ 1 · every catalog key can be switched somewhere ══');
ok(KEYS.length >= 8, `the catalog parsed (${KEYS.length} features) — a parse that found nothing must not pass`);
for (const k of KEYS) {
  if (EXEMPT[k]) { ok(true, `${k} — exempt, its switch lives in ${EXEMPT[k]}`); continue; }
  ok(!!HOMES[k], `${k} has a FEATURE_HOMES entry`);
}

console.log('\n══ 2 · every home resolves to a host that exists ══');
for (const [k, sel] of Object.entries(HOMES)) {
  ok(html.includes('id="' + sel.slice(1) + '"'), `${k} → ${sel} exists in retail-admin.html`);
}

console.log('\n══ 3 · no home points at a feature that is gone ══');
// §53 deleted two catalog entries; their homes went with them. A home left
// behind is dead weight that reads as coverage.
for (const k of Object.keys(HOMES)) {
  ok(KEYS.includes(k), `${k} is still in FEATURE_CATALOG`);
}

console.log('\n══ 4 · the exemptions still hold ══');
for (const [k, file] of Object.entries(EXEMPT)) {
  ok(KEYS.includes(k), `${k} is a real catalog key`);
  ok(read(...file.split('/')).includes(`'features.${k}'`),
     `and ${file} really does write features.${k}`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
