#!/usr/bin/env node
/**
 * THE DESKTOP TOOL RAIL STAYS OUT OF THE PHONE PREVIEW.
 *
 *   node scripts/test_mobile_editor_no_rail.js
 *
 * The phone page editor (cms-mobile.html) shows the desktop editor in an
 * iframe at ?embed=preview. The canvas layout, now the default, adds a tool
 * rail (+, page style, design check, help) as a 56px grid column. The embed
 * hides the editor's panes and drops the grid, but the rail was never in its
 * hide list: its four icons stacked across the top of the phone preview, and
 * every one opened the left pane, which the embed hides, so taps did nothing.
 *
 * No browser: what it pins is in the source.
 *   1. the embed's hide list covers the rail and its first-run tips;
 *   2. the tips are not started in the embed, where their auto-dismiss would
 *      mark them seen for the desktop editor on the same browser;
 *   3. the phone shell still has its own Add block and Design buttons, so
 *      hiding the rail takes nothing away.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CD = fs.readFileSync(path.join(ROOT, 'public/cms.html'), 'utf8');
const CM = fs.readFileSync(path.join(ROOT, 'public/cms-mobile.html'), 'utf8');

let passed = 0, failed = 0;
function it(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

// The rule whose selector list ends in display:none and contains the embed's
// hidden panes — found by content, not by line number.
function embedHideRule() {
  const re = /([^{}]*)\{\s*display:\s*none\s*!important;\s*\}/g;
  let m;
  while ((m = re.exec(CD))) {
    if (/\.fc-preview-embed \.pane\.left/.test(m[1])) return m[1];
  }
  throw new Error('embed hide rule not found');
}

console.log('\nphone preview hides the desktop rail');

it('the embed hide list covers .cf-rail', () => {
  assert.ok(/\.fc-preview-embed \.cf-rail\b/.test(embedHideRule()), '.cf-rail is not in the embed hide list');
});

it('the embed hide list covers the first-run tips (.cf-coach)', () => {
  assert.ok(/\.fc-preview-embed \.cf-coach\b/.test(embedHideRule()), '.cf-coach is not in the embed hide list');
});

it('the first-run tips are not started in the embed', () => {
  const calls = [...CD.matchAll(/^([^\n]*)cfMaybeCoach\(rail\)/gm)].filter((c) => !/function\s*$/.test(c[1]));
  assert.ok(calls.length >= 1, 'cfMaybeCoach(rail) call not found');
  for (const c of calls) {
    assert.ok(/fc-preview-embed/.test(c[1]), 'cfMaybeCoach is called without an embed guard: ' + c[0].trim());
  }
});

it('the phone shell keeps its own Add block and Design buttons', () => {
  assert.ok(/class="bb add" onclick="openAdd\(null\)"/.test(CM), 'phone Add block button missing');
  assert.ok(/onclick="openDesign\(\)"/.test(CM), 'phone Design button missing');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
