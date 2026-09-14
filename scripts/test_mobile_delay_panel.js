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

// TC000667, as it actually was on 2026-09-14. Both finished steps carry a
// SENTENCE rather than a stamp — one typed in Chinese, one in English — which
// is the shape that broke the row: `meta` was pinned at flex:none, so it could
// not shrink, ran off the card's right edge, and printed on top of a label that
// had been crushed onto two lines to make room for it.
const NOTED = SP({
  can_close: true, blockers: [],
  customer_told_at: '2026-09-14 07:34', customer_told_by: 'warehouse',
  dispute_state: 'no_claim', dispute_note: '客人收到包裹确认食品状态良好',
  remedy: 'none', remedy_at: '2026-09-14 09:03',
  remedy_note: 'customer said that package is in good condition', files: [],
});

// The panel, measured at the width it is actually drawn at. A phone is 390px
// and the sheet's padding takes 30 of them, so 330 is the card. Nothing here
// reads the markup: both faults this guards against are geometry, and a string
// assertion answered "yes" to the broken screen.
const MEASURE = `
  window.BOX = document.createElement('div');
  BOX.style.cssText = 'position:fixed;left:0;top:0;width:330px;z-index:99;background:#fff';
  document.body.appendChild(BOX);
  window.draw = function(sp, w){
    BOX.style.width = (w || 330) + 'px';
    BOX.innerHTML = delayCaseCard({id:1}, sp);
    window.LEAVES = [].slice.call(BOX.querySelectorAll('*')).filter(function(e){
      if (e.children.length || !(e.textContent||'').trim()) return false;
      var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    });
  };
  // What sticks out past the card's own right edge. One pixel of slack: a
  // fractional rect is not a layout fault.
  window.spill = function(){
    var edge = BOX.getBoundingClientRect().right;
    return LEAVES.filter(function(e){ return e.getBoundingClientRect().right > edge + 1; })
                 .map(function(e){ return e.textContent.trim().slice(0,18); });
  };
  // WHAT PAINTS OUTSIDE ITS OWN BOX — the fault a rectangle cannot show you.
  // A flex item with min-width:0 shrinks past its own text: the box measures
  // 13px, the word in it is still 51px, and those 38px print over whatever the
  // neighbour put there. Every rect involved still reads as perfectly tidy.
  window.crush = function(){
    return LEAVES.filter(function(e){ return e.scrollWidth > e.clientWidth + 1; })
                 .map(function(e){ return e.textContent.trim().slice(0,18)
                   + ' [' + e.clientWidth + 'px box / ' + e.scrollWidth + 'px text]'; });
  };
  // What is printed on top of what. Two text boxes may touch; they may not
  // share space.
  window.overprint = function(){
    var bad = [];
    for (var i=0;i<LEAVES.length;i++) for (var j=i+1;j<LEAVES.length;j++){
      var a = LEAVES[i].getBoundingClientRect(), b = LEAVES[j].getBoundingClientRect();
      if (a.left < b.right-1 && b.left < a.right-1 && a.top < b.bottom-1 && b.top < a.bottom-1)
        bad.push(LEAVES[i].textContent.trim().slice(0,14)+' over '+LEAVES[j].textContent.trim().slice(0,14));
    }
    return bad;
  };`;

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

  ['a typed note never lands on top of its own label',
   `${MEASURE}; draw(${NOTED});`,
   [['nothing is printed over anything else', 'overprint().length === 0'],
    ['no line is squeezed narrower than its own text', 'crush().length === 0'],
    ['nothing runs off the right edge of the card', 'spill().length === 0'],
    ['the note is still on screen in full',
     'BOX.innerText.indexOf("customer said that package is in good condition") > 0'],
    ['and so is the Chinese one', 'BOX.innerText.indexOf("客人收到包裹确认食品状态良好") > 0'],
    ['a short stamp stays beside its label, one line',
     'BOX.innerText.indexOf("warehouse · 09-14 07:34") > 0 && '
     + 'BOX.innerText.split("\\n").filter(function(l){return l.indexOf("Customer told") >= 0}).length === 1']]],

  ['the stamp-only panel is laid out too — the common case, measured',
   `${MEASURE}; draw(${DONE});`,
   [['nothing is printed over anything else', 'overprint().length === 0'],
    ['no line is squeezed narrower than its own text', 'crush().length === 0'],
    ['nothing runs off the right edge of the card', 'spill().length === 0']]],

  // 330 is the phone this app is built for. A narrower card is not a screen
  // anybody has — it is the same panel inside a mirrored-parcel list, a split
  // pane, a future surface — and the row has to survive it, because the way it
  // failed at 330 was by having no answer to being narrow.
  ['and it holds at a width narrower than any phone',
   `${MEASURE}; draw(${NOTED}, 260);`,
   [['nothing is printed over anything else', 'overprint().length === 0'],
    ['no line is squeezed narrower than its own text', 'crush().length === 0'],
    ['nothing runs off the right edge of the card', 'spill().length === 0']]],

  ['the parcel header says how late it was',
   `window.H = trackingCard({id:1}, Object.assign(${SP(null)}, {trk:{number:'JDVC1',status_label_en:'Delivered',status_code:'delivered',events:[]}}), 'Parcel 1');`,
   [['the lateness sits beside the status', 'H.indexOf("3 days late") > 0'],
    ['and the carrier’s own status is untouched', 'H.indexOf("Delivered") > 0']]],
], { settle: 0 });
