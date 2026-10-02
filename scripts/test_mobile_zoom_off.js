#!/usr/bin/env node
/**
 * THE PHONE APP CANNOT BE PINCH-ZOOMED (§420).
 *
 *   node scripts/test_mobile_zoom_off.js
 *
 * Zoom was switched back on for the September audit (R-01). A stray
 * two-finger touch then left the installed app zoomed about 12%: the right
 * edge and the whole tab bar off-screen, with nothing on screen to say why.
 * Ash turned it off again on 2026-10-02.
 *
 * No browser: what it pins is in the source.
 *   1. public/m.html has exactly one viewport tag, and it blocks zoom;
 *   2. the keys that tag already carried are still there (§282's
 *      interactive-widget among them), so this cannot have cost the keyboard
 *      fix;
 *   3. the customer-facing pages still allow zoom: the decision is the staff
 *      app only.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
const viewports = (src) => [...src.matchAll(/<meta name="viewport" content="([^"]*)">/g)].map((m) => m[1]);
const keys = (content) => Object.fromEntries(content.split(',').map((kv) => kv.trim().split('=').map((x) => x.trim())));

let pass = 0;
function ok(cond, m) { assert.ok(cond, m); pass++; console.log('  ✓ ' + m); }

// The app's own head, before its first script. Printed documents the app
// builds later (POs, count sheets) carry their own viewport tags and are not
// the app shell.
const M = read('m.html');
const head = M.slice(0, M.indexOf('</head>'));
const vp = viewports(head);
ok(vp.length === 1, 'm.html head has exactly one viewport tag');
const k = keys(vp[0]);
ok(k['user-scalable'] === 'no', 'm.html: user-scalable=no');
ok(k['maximum-scale'] === '1', 'm.html: maximum-scale=1');
ok(k.width === 'device-width' && k['initial-scale'] === '1', 'm.html: still device-width at scale 1');
ok(k['viewport-fit'] === 'cover', 'm.html: viewport-fit=cover kept');
ok(k['interactive-widget'] === 'resizes-content', 'm.html: interactive-widget=resizes-content kept (§282)');

for (const f of ['shop.html', 'storefront.html']) {
  if (!fs.existsSync(path.join(ROOT, 'public', f))) continue;
  for (const c of viewports(read(f))) {
    const kk = keys(c);
    ok(kk['user-scalable'] !== 'no' && kk['maximum-scale'] !== '1', `${f}: customer page still allows zoom`);
  }
}

console.log(`\n${pass} passed`);
