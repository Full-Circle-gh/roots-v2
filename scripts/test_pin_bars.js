#!/usr/bin/env node
/**
 * §282 on the desktop — a commit button never scrolls off the screen, on a
 * page (part 2) or in a pop-up (part 3).
 *
 *   node scripts/test_pin_bars.js
 *
 * Ash: "the button should be in reach at any giving moment on the screen. I
 * don't want the user to scroll finding the save button."
 *
 * Each long form's button row carries .pin-foot (sticky to the bottom while its
 * form is on screen); each page whose buttons live in its header carries
 * .pin-head. Whether sticky actually HOLDS depends on the boxes around it — an
 * overflow on any of them kills it — and that was checked in a browser when
 * each was added (the §282 PR records how). What this guards is the part that
 * rots silently: a later edit dropping the class from one of these rows, or the
 * shared rule losing its position, puts the button back at the end of a long
 * page and nothing else would notice.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const HTML = read('public/retail-admin.html');
const CSS = read('public/retail-admin.css');
const OPS = read('public/retail-admin/02-settings-ops.js');
const VOT = read('public/retail-admin/10-extras.js');
const PUR = read('public/retail-admin/16-purchasing.js');
const ORD = read('public/retail-admin/04-orders.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}
const count = (src, re) => (src.match(re) || []).length;

console.log('the shared rules');
ok(/\.pin-foot \{[^}]*position: sticky; bottom: 0/.test(CSS), '.pin-foot sticks to the bottom');
ok(/\.pin-head \{[^}]*position: sticky; top: var\(--pin-top, 0px\)/.test(CSS), '.pin-head sticks to the top');
ok(/#tab-voting \.vot-ed-head\.pin-head \{[^}]*--pin-top: 56px/.test(CSS),
  'the poll editor scrolls the window, so its header stops under the 56px topbar');
ok(/#tab-orders-new \.onw-right \{ top: 82px; \}/.test(CSS),
  'New order\'s running total stops under the pinned header, not beneath it');

console.log('\npages whose buttons are in the header');
ok(HTML.includes('<div class="onw-head pin-head">'), 'Orders → New order');
ok(HTML.includes('<div class="mat-rechead pin-head">'), 'Material record');
ok(VOT.includes('<div class="vot-ed-head pin-head">'), 'Voting → the poll editor');

console.log('\nforms whose buttons are at the end');
ok(count(HTML, /<div class="fb-save pin-foot">\s*<button class="btn" onclick="saveBatchSchedule\(\)">/g) === 2,
  'Fresh batches: the schedule and the checkout pop-up');
ok(/<div class="pin-foot"[^>]*>\s*<button class="btn" onclick="_savePrinter\(\)">/.test(HTML), 'Cloud printers: Save all');
ok(HTML.includes('<div class="bx-sendbar pin-foot">'), 'Broadcasts: Send');
ok(/<div class="pin-foot"[^>]*>\s*\$\{isEdit/.test(OPS), 'Settings → Operations: a new store');
ok(count(PUR, /<div class="pu2-wizfoot pin-foot">/g) === 5,
  'Purchasing: order steps 1–3, a new supplier, the supplier import');
ok(PUR.includes('<div class="pu2-actions pin-foot">\n        ${canReceive'), 'Purchasing: Confirm delivery');
ok(!/<div class="pu2-wizfoot">/.test(PUR), 'no purchasing footer was left unpinned');

console.log('\npop-ups: the foot stays put while the body scrolls');
ok(/#prod-view-purchasing \.pu2-modal \{ display: flex; flex-direction: column; overflow: hidden; \}/.test(CSS)
  && /#prod-view-purchasing \.pu2-modal > \.pu2-modal-body \{[^}]*overflow: auto/.test(CSS),
  'every purchasing pop-up (invoice, set supplier, re-match) scrolls its body, not its foot');
ok(/\.fsd-drawer \.fsc-foot \{ position: sticky; bottom: 0/.test(HTML), 'Flash sale: Start / Schedule');
ok(/:is\(#tab-sales, \.cfg-host\) \.mc-wiz > \.mc-foot \{\s*position: sticky; bottom: 0/.test(CSS),
  'Channel set-up (keys, the WeChat wizard, the web shop): Save / Next');
for (const id of ['drf-submit', 'rf-submit']) {
  const at = ORD.indexOf('id="' + id + '"');
  const foot = ORD.lastIndexOf('<div class="pu-editor-foot">', at);
  ok(at > 0 && foot > 0 && at - foot < 300, `Refund: #${id} is in the pop-up's foot, outside the scrolling body`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
