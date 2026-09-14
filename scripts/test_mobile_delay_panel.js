#!/usr/bin/env node
/**
 * The late-parcel panel on the phone — its HIERARCHY, not its wording (§98).
 *
 * test_mobile_screens.js proves every screen paints, and it never seeds a delay
 * case, so until this file existed the panel that works a spoiled parcel had no
 * render check on this surface at all. What it locks is the thing that was
 * wrong on 2026-09-14 and the thing most likely to come back:
 *
 *   ONE PRIMARY BUTTON, ALWAYS. The panel had six controls of identical weight,
 *   including one ('Not claiming') that permanently ends the claim track and one
 *   ('Add photo') for the single step that gates nothing. A screen where
 *   everything is emphasised has no emphasis, and that is not a wording bug a
 *   string assertion would catch.
 *
 *   BRICK IS THE HEADER'S. The whole block used to sit in brick tint with brick
 *   ink, done steps included, so the alarm colour meant nothing. One tinted
 *   surface per panel, and it is the strip at the top.
 *
 * It calls delayCaseCard directly rather than driving the order sheet: the
 * panel's states are four columns of a case row, and reaching all of them
 * through the sheet would mean seeding four orders to test one function.
 */
'use strict';

const { run } = require('./lib/m-probe');

// Everything the phone reads off a parcel. `dcase` is lib/delay-case.js's own
// forScreen() shape — blockers and can_close come from there and are never
// recomputed here, which is the rule the panel itself follows.
const SP = (dcase) => JSON.stringify({ id: 7, mode: 'air', lateDays: 3, airCleared: null, dcase });

const FRESH = SP({
  can_close: false, blockers: ['customer_not_told', 'customer_not_made_whole', 'dispute_open'],
  dispute_state: 'none', customer_told_at: null, remedy: null, files: [],
});
const MID = SP({
  can_close: false, blockers: ['customer_not_made_whole', 'dispute_open'],
  customer_told_at: '2026-09-14 04:06', customer_told_by: 'owner',
  dispute_state: 'filed', dispute_filed_at: '2026-09-12 09:00', dispute_ref: 'JD-88',
  remedy: null, files: [{ id: 1, label: 'box.jpg' }],
});
const DONE = SP({
  can_close: true, blockers: [],
  customer_told_at: '2026-09-14 04:06', customer_told_by: 'owner',
  dispute_state: 'paid', dispute_filed_at: '2026-09-12 09:00', dispute_received: 120,
  remedy: 'replacement', remedy_at: '2026-09-13 10:00', files: [],
});
const NO_CLAIM = SP({
  can_close: true, blockers: [],
  customer_told_at: '2026-09-14 04:06', customer_told_by: 'owner',
  dispute_state: 'no_claim', dispute_note: 'value too small',
  remedy: 'refund', remedy_at: '2026-09-13 10:00', files: [],
});

// How many times a snippet occurs. `class="cta"` is the filled button and there
// is never more than one of it.
const count = 'function count(h,s){return h.split(s).length-1}';

run('mobile delay panel', [
  ['nothing done yet',
   `${count}; window.H = delayCaseCard({id:1}, ${FRESH});`,
   [['exactly one primary button', 'count(H,\'class="cta"\') === 1'],
    ['one tinted surface, and it is the header', 'count(H,"var(--brick-tint)") === 1'],
    ['the next step is the customer', 'H.indexOf("Next") < H.indexOf("Customer told")'],
    ['not claiming is not a button', 'H.indexOf("rowact") > 0'],
    ['the footer names all three blockers',
     'H.indexOf("Tell the customer") > 0 && H.indexOf("Replacement or refund") > 0 && H.indexOf("Carrier settled") > 0'],
    ['the old blanket refusal is gone', 'H.indexOf("Close once every step") < 0'],
    ['nothing is done yet', 'H.indexOf("0/4") > 0']]],

  ['told, claim filed, carrier still owes an answer',
   `${count}; window.H = delayCaseCard({id:1}, ${MID});`,
   [['still exactly one primary button', 'count(H,\'class="cta"\') === 1'],
    ['still one tinted surface', 'count(H,"var(--brick-tint)") === 1'],
    ['two of four done', 'H.indexOf("2/4") > 0'],
    ['the finished call carries who and when', 'H.indexOf("owner") > 0'],
    ['evidence is attached and is not a primary', 'H.indexOf("box.jpg") > 0'],
    ['the remedy is still reachable out of order', 'H.indexOf("Send replacement") > 0'],
    ['the footer names what is left, not the whole list',
     'H.indexOf("Replacement or refund") > 0 && H.indexOf("Tell the customer") < 0']]],

  ['every step done — the close is offered',
   `${count}; window.H = delayCaseCard({id:1}, ${DONE});`,
   [['the close is the one primary', 'count(H,\'class="cta"\') === 1'],
    ['and it is Mark handled', 'H.indexOf("Mark handled") > 0'],
    ['no step is promoted any more', 'H.indexOf("Next") < 0'],
    ['four of four', 'H.indexOf("4/4") > 0']]],

  ['not claiming — the carrier step is not counted',
   `${count}; window.H = delayCaseCard({id:1}, ${NO_CLAIM});`,
   [['three steps, not four', 'H.indexOf("3/3") > 0'],
    ['exactly one primary button', 'count(H,\'class="cta"\') === 1'],
    ['the reason is shown', 'H.indexOf("value too small") > 0']]],

  ['the parcel header says how late it was',
   `window.H = trackingCard({id:1}, Object.assign(${SP(null)}, {trk:{number:'JDVC1',status_label_en:'Delivered',status_code:'delivered',events:[]}}), 'Parcel 1');`,
   [['the lateness sits beside the status', 'H.indexOf("3 days late") > 0'],
    ['and the carrier’s own status is untouched', 'H.indexOf("Delivered") > 0']]],
], { settle: 0 });
