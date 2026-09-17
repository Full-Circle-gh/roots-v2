#!/usr/bin/env node
/**
 * A FINISHED STEP IN THE LATE-PARCEL PANEL KEEPS ITS TWO SLOTS APART.
 *
 *   node scripts/test_delay_panel_rows.js
 *
 * WHAT WENT WRONG. The done row — tick, label, and what closed it — carried the
 * label and everything after it on one line, with the right-hand slot pinned at
 * `flex:none`. That slot held two different kinds of thing: a stamp (who, when,
 * how much — short and bounded) and a sentence somebody typed into a reason
 * field, which is neither. A sentence pinned at flex:none cannot shrink, so on
 * TC000667 it ran off the right edge of the card while the label beside it was
 * squeezed to a few pixels wide and painted its own letters out over the top of
 * the note. Two strings, one place on the glass.
 *
 * WHY THIS SUITE IS TEXT AND NOT PIXELS. The measurement that proves it is in
 * scripts/test_mobile_delay_panel.js — it draws the panel at a phone's width and
 * asserts that nothing paints outside its own box. That suite drives Chromium,
 * so it lives in the SLOW shard, and the slow shard is not run here (CLAUDE.md,
 * "Tests"). A guard nobody runs guards nothing, so the CONTRACT the fix rests on
 * is asserted here, in the shard that is the gate:
 *
 *   1. Both surfaces' done row takes the stamp and the note as separate things.
 *   2. Neither pins that row's right-hand slot at flex:none again.
 *   3. No free-text field — a typed reason — is ever built into the stamp.
 *
 * Both surfaces, because §98's two halves have drifted apart before and this is
 * one layout with two implementations.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

// The two surfaces: the phone's panel and the order drawer's. Each entry names
// the file, the row builder, and the function that describes the steps.
const SURFACES = [
  { what: 'the phone', file: 'public/m.html',
    row: 'function mDcDone(', steps: 'function delayCaseCard(', call: 'mDcDone(st.label' },
  { what: 'the order drawer', file: 'public/retail-admin/04-orders.js',
    row: 'function delayDone(', steps: 'function renderDelayCase(', call: 'delayDone(st.label' },
];

// A function's source, from its signature to the first line that closes it at
// column zero — the house slice, as scripts/test_drawer_back_nav.js cuts one.
function body(src, sig) {
  const from = src.indexOf(sig);
  if (from < 0) return '';
  const end = src.indexOf('\n}\n', from);
  return src.slice(from, end < 0 ? src.length : end + 2);
}

for (const s of SURFACES) {
  section(`${s.what} — ${s.file}`);
  const src = fs.readFileSync(path.join(ROOT, s.file), 'utf8');
  const row = body(src, s.row);
  const steps = body(src, s.steps);

  yes(row.length > 0, 'the done row builder is where this suite thinks it is',
    `${s.row} not found`);

  // 1 — the stamp and the note are two arguments, and the caller passes both.
  // MATCHED UP TO `note`, NOT TO THE CLOSING BRACKET. What this guards is that
  // a stamp and a sentence never share one slot again; it is not a pin on the
  // builder's arity, and reading it as one made a row that grew a fourth
  // argument (`na`, the marker for a step that does not apply) look like the
  // fault this file exists to catch.
  yes(/\(\s*label\s*,\s*meta\s*,\s*note\s*[,)]/.test(row.split('\n')[0] + row.split('\n')[1]),
    'the row takes the stamp and the note separately');
  yes(new RegExp(s.call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*,\\s*st\\.meta\\s*,\\s*st\\.note').test(steps),
    'and the step hands it both');

  // 2 — the slot that could not shrink. THE WHOLE FAULT, in one declaration.
  yes(!/flex\s*:\s*none/.test(row.slice(row.indexOf('${meta'))),
    'the stamp is not pinned at flex:none any more — it can shrink',
    'flex:none on the right-hand slot is what pushed a typed note off the card');
  yes(/overflow-wrap\s*:\s*anywhere/.test(row),
    'and something in the row is allowed to break rather than overflow');

  // 3 — a typed reason never reaches the stamp. `dispute_note` and
  // `remedy_note` are the two free-text fields a human fills in; every other
  // thing in that slot is a name, a date, a waybill or an amount.
  const intoStamp = steps.split('\n')
    .filter((l) => l.indexOf('meta:') >= 0 || l.indexOf('meta: ') >= 0)
    .map((l) => {
      const after = l.slice(l.indexOf('meta:'));
      const cut = after.search(/,\s*note\s*:/);
      return cut < 0 ? after : after.slice(0, cut);
    })
    .filter((expr) => /(dispute|remedy)_note/.test(expr));
  yes(intoStamp.length === 0,
    'no typed reason is built into the stamp',
    intoStamp.join('\n      '));

  // The stamp is also assembled a piece at a time, into an array, a line above
  // where it is handed over — which is where the remedy's reason used to be
  // pushed in and where a `meta:` scan alone would never look.
  const pushedIn = steps.split('\n')
    .filter((l) => /\.push\(/.test(l) && !/steps\.push/.test(l) && /(dispute|remedy)_note/.test(l));
  yes(pushedIn.length === 0,
    'nor pushed into it a piece at a time',
    pushedIn.join('\n      '));

  // And the free text still reaches the screen — moved, not dropped.
  yes(/note\s*:\s*[^,}]*dispute_note/.test(steps), 'the claim reason still prints, as a note');
  yes(/note\s*:\s*[^,}]*remedy_note/.test(steps) || /note\s*:\s*rnote/.test(steps)
      || /note\s*:\s*remedyNote/.test(steps),
    'and so does the remedy reason');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
