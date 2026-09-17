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

// The panel as a reader sees it, with the markup taken out. The step numerals
// and the footer's are single characters sitting in their own span, so a raw
// markup assertion on them would be pinning a style attribute rather than what
// the row says; stripped text asserts "3 Replacement or refund" as one thing.
const strip = 'function strip(h){return h.replace(/<[^>]*>/g," ").replace(/\\s+/g," ").trim()}';
const SETUP = `${count}; ${strip}; state.dcMore=null;`;

run('mobile delay panel', [
  ['nothing done yet',
   `${SETUP} window.H = delayCaseCard({id:1}, ${FRESH}); window.TX = strip(H);`,
   [['exactly one primary button', 'count(H,\'class="cta"\') === 1'],
    ['one tinted surface, and it is the header', 'count(H,"var(--brick-tint)") === 1'],
    ['the next step is the customer', 'H.indexOf("Next") < H.indexOf("Customer told")'],
    ['and it says which of the four it is', 'TX.indexOf("Next · 1/4") > 0'],
    // The complaint this answers: the header counted 1/4 and no row on screen
    // carried a 1, a 2, a 3 or a 4 for it to be counting.
    ['every later step carries its number',
     'TX.indexOf("2 Claim the delay off the carrier") > 0 && TX.indexOf("3 Replacement or refund") > 0 '
     + '&& TX.indexOf("4 Carrier settled") > 0'],
    // Six controls at once was the whole of "not clear". The later steps' are
    // folded; the next step's are not.
    ['a later step keeps its controls folded away',
     'H.indexOf("Claim filed") < 0 && H.indexOf("Send replacement") < 0 && H.indexOf("Nothing needed") < 0'],
    ['the step that is next keeps its own', 'H.indexOf("Customer told") > 0'],
    ['evidence is still offered, and is still not a primary', 'H.indexOf("rowact") > 0'],
    ['the footer names all three blockers, by number', 'TX.indexOf("to do: 1 · 3 · 4") > 0'],
    ['and does not repeat the rows it is pointing at', 'H.indexOf("Tell the customer") === H.lastIndexOf("Tell the customer")'],
    ['the old blanket refusal is gone', 'H.indexOf("Close once every step") < 0'],
    ['nothing is done yet', 'H.indexOf("0/4") > 0']]],

  // The fold is not a lock. A step out of turn — the carrier rings while the
  // remedy is open — is one tap away and keeps its quiet weight when it opens.
  ['a folded step opens, and nothing else changes weight',
   `${SETUP} state.dcMore='7:1'; window.H = delayCaseCard({id:1}, ${FRESH}); state.dcMore=null;`,
   [['the claim controls are out', 'H.indexOf("Claim filed") > 0'],
    ['not claiming is still not a button', 'H.indexOf("Not claiming") > 0 && H.indexOf("rowact") > 0'],
    ['the next step still holds the only primary', 'count(H,\'class="cta"\') === 1'],
    ['and the other later step stays folded', 'H.indexOf("Send replacement") < 0']]],

  ['told, claim filed, carrier still owes an answer',
   `${SETUP} window.H = delayCaseCard({id:1}, ${MID}); window.TX = strip(H);`,
   [['still exactly one primary button', 'count(H,\'class="cta"\') === 1'],
    ['still one tinted surface', 'count(H,"var(--brick-tint)") === 1'],
    ['two of four done', 'H.indexOf("✓ 2/4") > 0'],
    ['and the next step is the third of them', 'TX.indexOf("Next · 3/4") > 0'],
    ['the finished call carries who and when', 'H.indexOf("owner") > 0'],
    ['evidence is attached and is not a primary', 'H.indexOf("box.jpg") > 0'],
    ['the remedy is the next step, so its controls are out', 'H.indexOf("Send replacement") > 0'],
    ['the carrier answer is folded until it is asked for', 'H.indexOf("Carrier paid") < 0'],
    ['the footer names what is left, by number',
     'TX.indexOf("to do: 3 · 4") > 0 && TX.indexOf("to do: 1") < 0']]],

  ['every step done — the close is offered',
   `${SETUP} window.H = delayCaseCard({id:1}, ${DONE});`,
   [['the close is the one primary', 'count(H,\'class="cta"\') === 1'],
    ['and it is Mark handled', 'H.indexOf("Mark handled") > 0'],
    ['no step is promoted any more', 'H.indexOf("Next") < 0'],
    ['four of four', 'H.indexOf("4/4") > 0']]],

  ['not claiming — the carrier step is not counted',
   `${SETUP} window.H = delayCaseCard({id:1}, ${NO_CLAIM}); window.TX = strip(H);`,
   [['three steps, not four', 'H.indexOf("3/3") > 0'],
    ['exactly one primary button', 'count(H,\'class="cta"\') === 1'],
    ['the reason is shown', 'H.indexOf("value too small") > 0'],
    // A step nobody did is not a step somebody finished. It used to carry a
    // green tick with a '–' in the stamp slot, which read as done.
    ['the carrier step is marked n/a rather than ticked', 'TX.indexOf("– Carrier settled") > 0']]],

  ['a typed note never lands on top of its own label',
   `${SETUP} ${MEASURE}; draw(${NOTED});`,
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
   `${SETUP} ${MEASURE}; draw(${DONE});`,
   [['nothing is printed over anything else', 'overprint().length === 0'],
    ['no line is squeezed narrower than its own text', 'crush().length === 0'],
    ['nothing runs off the right edge of the card', 'spill().length === 0']]],

  // 330 is the phone this app is built for. A narrower card is not a screen
  // anybody has — it is the same panel inside a mirrored-parcel list, a split
  // pane, a future surface — and the row has to survive it, because the way it
  // failed at 330 was by having no answer to being narrow.
  ['and it holds at a width narrower than any phone',
   `${SETUP} ${MEASURE}; draw(${NOTED}, 260);`,
   [['nothing is printed over anything else', 'overprint().length === 0'],
    ['no line is squeezed narrower than its own text', 'crush().length === 0'],
    ['nothing runs off the right edge of the card', 'spill().length === 0']]],

  // THE STATE IN THE PHOTOGRAPH, MEASURED. Every geometry case above draws a
  // panel whose steps are all finished — the shape that broke TC000667 — so
  // the numbered row, the chevron and the folded block had no measurement at
  // all until here. A fresh case is also the widest thing this panel ever draws.
  ['a fresh case is laid out too — numbered rows and a chevron, measured',
   `${SETUP} ${MEASURE}; draw(${FRESH});`,
   [['nothing is printed over anything else', 'overprint().length === 0'],
    ['no line is squeezed narrower than its own text', 'crush().length === 0'],
    ['nothing runs off the right edge of the card', 'spill().length === 0'],
    ['the numerals are on screen, not just in the markup',
     'BOX.innerText.indexOf("Claim the delay off the carrier") > 0 && /(^|\\n)\\s*2\\b/.test(BOX.innerText)']]],

  ['and with a step unfolded, at a width narrower than any phone',
   `${SETUP} state.dcMore='7:1'; ${MEASURE}; draw(${FRESH}, 260); state.dcMore=null;`,
   [['nothing is printed over anything else', 'overprint().length === 0'],
    ['no line is squeezed narrower than its own text', 'crush().length === 0'],
    ['nothing runs off the right edge of the card', 'spill().length === 0'],
    ['the controls it unfolded are visible', 'BOX.innerText.indexOf("Claim filed") > 0']]],

  ['the parcel header says how late it was',
   `window.H = trackingCard({id:1}, Object.assign(${SP(null)}, {trk:{number:'JDVC1',status_label_en:'Delivered',status_code:'delivered',events:[]}}), 'Parcel 1');`,
   [['the lateness sits beside the status', 'H.indexOf("3 days late") > 0'],
    ['and the carrier’s own status is untouched', 'H.indexOf("Delivered") > 0']]],
], { settle: 0 });
