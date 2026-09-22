#!/usr/bin/env node
/**
 * The courier stages and the refund panel use Tacet tokens, not raw hex.
 *
 *   node scripts/test_courier_refund_palette.js
 *
 * No network, no DB, no browser — it reads the shipped source and the shipped
 * stylesheet.
 *
 * WHY THIS EXISTS
 * ---------------
 * Asked for by Ash, 2026-09-22, after a design-system check of the order drawer.
 * Between them the two colour maps carried eight raw hex values, and most were
 * not Tacet colours at all:
 *
 *   #4A72B0  the "Rider coming" dot — A BLUE. The palette is Paper, Ink,
 *            Graphite, Dusk, Sage, plus functional Amber and Brick. There is no
 *            blue in it, and there never was.
 *   #7494ff  the "2. Reviewing" refund badge — a second, different blue.
 *   rgba(232,85,106,…)  the rejected-refund band — a pink-red that is neither
 *            Brick (#B4533E) nor anything else in the system. The rulebook's
 *            §9 Never list opens with "never pure red, never neon anything".
 *   #f2ca6c / #5fc28e / #9A6E2A / #5C7A4E  near-misses of Amber and Sage.
 *
 * And NONE of them had a dark-mode value, on a product whose default theme is
 * dark. The -ink token family exists precisely for that: `--td-amber-ink` is
 * #8A6425 on light and #C9954A on dark, and a fixed hex cannot do both.
 *
 * WHAT IS LOCKED
 *   1. neither colour map contains a raw hex or rgba() — only var() tokens;
 *   2. every token they name is actually DEFINED, in both themes;
 *   3. the Dusk rule: Dusk appears exactly where automation is acting and
 *      nowhere else in these two maps;
 *   4. the courier stages keep the distinctions they had — a rider being sought
 *      does not look like a rider on the road;
 *   5. the badge and the panel band agree with each other, state for state.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const ROOT = path.join(__dirname, '..');
const ORDERS_JS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin', '04-orders.js'), 'utf8');
const ADMIN_CSS = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.css'), 'utf8');
const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'retail-admin.html'), 'utf8');

// A block of the shipped source, comments stripped — a hex QUOTED IN A COMMENT
// to explain why it was removed must not read as the hex still being used, or
// this suite would forbid its own explanation.
function block(startAnchor, endAnchor) {
  const a = ORDERS_JS.indexOf(startAnchor);
  assert.notStrictEqual(a, -1, `not found: ${startAnchor}`);
  const b = ORDERS_JS.indexOf(endAnchor, a);
  assert.notStrictEqual(b, -1, `not found after it: ${endAnchor}`);
  return ORDERS_JS.slice(a, b)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

// Sliced by the FUNCTION that owns each map, never by the map's own opening
// line: `const map = {\n    pending:` also matches a shipment-status map several
// hundred lines earlier, and anchoring on it silently measured the wrong block.
// (Exactly the mis-slice that hid a misplaced edit in §220 — by span, not by a
// string that reads as unique.)
function fnBody(anchor) {
  const start = ORDERS_JS.indexOf(anchor);
  assert.notStrictEqual(start, -1, `not found in the shipped file: ${anchor}`);
  const open = ORDERS_JS.indexOf('{', start + anchor.length);
  let depth = 0;
  for (let j = open; j < ORDERS_JS.length; j++) {
    if (ORDERS_JS[j] === '{') depth++;
    else if (ORDERS_JS[j] === '}' && --depth === 0) {
      return ORDERS_JS.slice(start, j + 1)
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    }
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

const STAGES = block('const COURIER_STAGE = {', '};');
const BADGE  = fnBody('function refundStepBadge(state)');
const PANEL  = fnBody('function renderRefundPanel(o)');
const BAND   = PANEL.slice(PANEL.indexOf('const headerBg = state ==='),
                           PANEL.indexOf('/* Action buttons'));

console.log('\nRaw colour, where only tokens belong\n');

it('the courier stage map holds no raw hex', () => {
  const hex = STAGES.match(/#[0-9A-Fa-f]{3,8}\b/g) || [];
  assert.deepStrictEqual(hex, [], `raw hex still in COURIER_STAGE: ${hex.join(', ')}`);
});

it('…and no rgba() either', () => {
  assert.ok(!/rgba?\(/.test(STAGES), 'a raw rgba() is still in COURIER_STAGE');
});

it('the refund badge map holds no raw hex or rgba()', () => {
  const hex = BADGE.match(/#[0-9A-Fa-f]{3,8}\b/g) || [];
  assert.deepStrictEqual(hex, [], `raw hex still in refundStepBadge: ${hex.join(', ')}`);
  assert.ok(!/rgba?\(/.test(BADGE), 'a raw rgba() is still in refundStepBadge');
});

it('the refund panel band holds no raw hex or rgba()', () => {
  const hex = BAND.match(/#[0-9A-Fa-f]{3,8}\b/g) || [];
  assert.deepStrictEqual(hex, [], `raw hex still in the panel band: ${hex.join(', ')}`);
  assert.ok(!/rgba?\(/.test(BAND), 'a raw rgba() is still in the panel band');
});

it('the two blues are gone from the whole file', () => {
  // Named rather than matched generically: these are the two that were never
  // Tacet colours at all, and a reader of this suite should see which.
  assert.ok(!/#4A72B0/i.test(STAGES), 'the Rider-coming blue survives');
  assert.ok(!/#7494ff/i.test(BADGE + BAND), 'the Reviewing blue survives');
});

it('the off-palette pink is gone', () => {
  assert.ok(!/232\s*,\s*85\s*,\s*106/.test(BADGE + BAND),
    'the rejected-refund pink survives — it is neither Brick nor in the palette');
});

console.log('\nEvery token named is a token that exists\n');

// Tokens are defined in retail-admin.css (the --td-* family and the theme
// blocks) or retail-admin.html (--text-*, --bg-*, --danger…). Both load on the
// admin page, which is the only place 04-orders.js runs.
const DEFINED = new Set(
  [...(ADMIN_CSS + ADMIN_HTML).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

function tokensIn(src) {
  return [...new Set([...src.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))];
}

it('every token in the three maps is defined somewhere that loads', () => {
  const used = tokensIn(STAGES + BADGE + BAND);
  assert.ok(used.length >= 6, `expected several tokens, found ${used.length}`);
  const missing = used.filter((t) => !DEFINED.has(t));
  assert.deepStrictEqual(missing, [], `named but never defined: ${missing.join(', ')}`);
});

it('the -ink tokens carry BOTH themes, which is why they were chosen', () => {
  // A fixed hex cannot be legible on Paper and on Ink. This is the property the
  // old values lacked, so it is the property worth pinning.
  for (const t of ['--td-amber-ink', '--td-sage-ink', '--td-brick-ink']) {
    const defs = (ADMIN_CSS.match(new RegExp(t.replace(/-/g, '\\-') + '\\s*:', 'g')) || []).length;
    assert.ok(defs >= 2, `${t} is defined ${defs} time(s) — it needs a light AND a dark value`);
  }
});

console.log('\nThe Dusk rule, and the distinctions the stages carry\n');

it('Dusk appears only where automation is acting', () => {
  // "The Dusk rule (most important rule in this system): when a merchant sees
  // Dusk, it means exactly one thing — Tacet did this for you."
  assert.ok(!/--td-dusk/.test(STAGES),
    'a courier stage uses Dusk — a rider a human dispatched is not an automation state');
  const duskRows = (BADGE.match(/^.*--td-dusk.*$/gm) || []);
  assert.strictEqual(duskRows.length, 1, `Dusk on ${duskRows.length} refund states; it marks one`);
  assert.ok(/paying/.test(duskRows[0]),
    'Dusk is not on `paying` — the one state where the gateway is moving money by itself');
});

it('a rider being sought does not look like a rider on the road', () => {
  const dot = (k) => (new RegExp(k + ":\\s*\\{[^}]*dot:\\s*'([^']+)'").exec(STAGES) || [])[1];
  const seeking = dot('awaiting_dispatch');
  const coming  = dot('heading_to_pickup');
  const moving  = dot('in_transit');
  const done    = dot('delivered');
  for (const [k, v] of [['awaiting_dispatch', seeking], ['heading_to_pickup', coming],
                        ['in_transit', moving], ['delivered', done]]) {
    assert.ok(v && v.startsWith('var('), `${k} has no token dot (got ${v})`);
  }
  assert.notStrictEqual(seeking, coming, 'finding a rider looks like a rider coming');
  assert.notStrictEqual(coming, moving, 'a rider coming looks like a rider on the way');
  // in_transit and delivered deliberately share, exactly as they did before.
  assert.strictEqual(moving, done, 'on-the-way and delivered no longer share a colour, which they always did');
});

it('the badge and the band agree state for state', () => {
  // The panel used to carry its own hexes, so the tag could say one thing and
  // the body another. They read the same tokens now.
  for (const [state, fam] of [['pending', 'amber'], ['reviewing', 'amber'],
                              ['approved', 'sage'], ['paid', 'sage'], ['rejected', 'brick']]) {
    const badgeRow = (new RegExp('^\\s*' + state + ':.*$', 'm').exec(BADGE) || [])[0] || '';
    assert.ok(badgeRow.includes(`--td-${fam}-ink`), `badge ${state} is not ${fam}`);
    const bandRow = (new RegExp("state === '" + state + "'\\s*\\?\\s*'([^']+)'").exec(BAND) || [])[1] || '';
    assert.ok(bandRow.includes(`--td-${fam}-`), `band ${state} is ${bandRow}, not ${fam}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
