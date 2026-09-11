#!/usr/bin/env node
/**
 * The phone's self-refresh knows when to keep its hands off.
 *
 *   node scripts/test_mobile_live_guards.js
 *
 * The wiring half of this — same endpoint as the desktop, same interval, the
 * Recap deliberately left out — is test_mobile_live.js, which needs no browser
 * and runs in the fast shard. This is the half that needs a real DOM: what the
 * refresh does when it lands at the wrong moment.
 *
 * WHY THE RESTRAINT IS THE PART WORTH TESTING. render() rewrites the whole app
 * in one innerHTML. It puts the scroll position back (_scrollMem) but a caret
 * only when the handler that caused the paint asked for one — so a repaint
 * nobody requested empties the field an operator is typing in, and it has
 * nothing at all to say to a half-counted delivery. That failure does not look
 * like a bug when it happens. It looks like the operator's own thumb, four
 * times an hour, and it would be blamed on them for months before anybody
 * thought to suspect the screen.
 *
 * EVERY REFUSAL IS ALSO ASSERTED TO BE TEMPORARY — the nudge stays owed in
 * `dirty` and the next tick spends it. A guard that silently drops the update
 * it was meant to defer is the original complaint ("I have to refresh to see
 * updates") wearing a different hat, and it would be the harder one to find.
 */
'use strict';

const { run } = require('./lib/m-probe');

/* Deterministic visibility: headless Chrome has its own opinion about whether a
   dumped page was ever on screen, and every guard below is downstream of that
   one answer. Asserting against the browser's default would make this suite
   pass or fail on the flag the harness happened to pass. */
const VISIBLE = "Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'visible'}});";

run('mobile live-refresh', [
  ['a board somebody is looking at refreshes itself', VISIBLE, [
    ['mAutoOK() refuses a clean, visible screen', 'mAutoOK()===true'],
  ]],

  /* THE BOOT ALREADY DID THIS — loadLive reaches mLiveInit even over file://,
     where every fetch under it fails as a network error rather than a 401 and
     the boot runs on to the end. So the state asserted here is the state the
     app arms itself into, not one the probe set up, which is the stronger
     version of the check. */
  ['the boot arms the backstop by itself', VISIBLE, [
    ['loadLive never reached mLiveInit', '_mLive.wired===true'],
    ['the 60s backstop was never armed', '_mLive.timer!==null'],
    ['and a second call would re-run the wiring', '(mLiveInit(), _mLive.timer!==null)'],
  ]],

  /* WHICH ENDPOINT IT ASKS FOR. EventSource is stubbed rather than allowed to
     connect — over file:// the real one cannot open at all (the next case is
     that) — and the singleton is cleared first because the boot has already
     spent its one attempt. The app reads `EventSource` as a free identifier,
     so a property on window is what it resolves to. */
  ['and it subscribes to the endpoint the desktop uses', VISIBLE + `
    window.__opened=null;
    window.EventSource=function(u){ window.__opened=u; this.readyState=0; };
    window.EventSource.prototype.addEventListener=function(){};
    _mLive.es=null; mLiveConnect();`, [
    ['the stream was never opened', '_mLive.es!==null'],
    ['it subscribed somewhere other than the desktop\'s endpoint',
      "window.__opened==='/api/retail-admin/stream'"],
  ]],

  /* EventSource retries by itself, but only until it gives up for good — a
     handset in a tunnel, a proxy that dropped the socket. After that the board
     would run on the 60s backstop alone, quietly, forever, and the only symptom
     would be updates arriving a minute late instead of at once: the original
     complaint, quieter, and much harder to find. Coming back to the app is the
     moment that gets fixed. */
  ['a stream the browser gave up on is re-opened on the way back', VISIBLE + `
    window.__opened=null;
    window.EventSource=function(u){ window.__opened=u; this.readyState=0; };
    window.EventSource.prototype.addEventListener=function(){};
    _mLive.es=null;
    document.dispatchEvent(new Event('visibilitychange'));`, [
    ['coming back left the stream closed', '_mLive.es!==null'],
    ['and it re-opened somewhere other than the stream',
      "window.__opened==='/api/retail-admin/stream'"],
  ]],

  /* THE DEGRADATION PATH, and this environment is a genuine instance of it
     rather than a simulated one: over file:// the browser refuses an
     EventSource outright, which is what a corporate proxy that will not pass an
     event stream does to a real shop. The claim being pinned is that the board
     still keeps itself current on the 60s backstop alone — which is why that
     poll is not written as a fallback the stream switches off. */
  ['a stream that cannot be opened leaves the backstop carrying it', VISIBLE, [
    ['the stream opened over file:// after all — this case is no longer testing anything',
      '_mLive.es===null'],
    ['and the backstop went down with it', '_mLive.timer!==null'],
  ]],

  ['but not while the app is off screen', `
    Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'hidden'}});`, [
    ['a hidden page still auto-refreshes', 'mAutoOK()===false'],
    ['and a nudge arriving there is remembered', '(_mLive.dirty=false, mLiveNudge(), _mLive.dirty===true)'],
  ]],

  /* THE ONE THAT MATTERS MOST, because it is invisible when it breaks: an
     operator typing a waste note or a stock count loses the characters and
     reads it as their own thumb. */
  ['not while a field has focus', VISIBLE + `
    var i=document.createElement('input'); document.body.appendChild(i); i.focus();`, [
    ['mTyping() does not see the focused field', 'mTyping()===true'],
    ['and the refresh runs over it anyway', 'mAutoOK()===false'],
    ['the nudge is deferred rather than dropped', '(_mLive.dirty=false, mLiveNudge(), _mLive.dirty===true)'],
  ]],

  ['not while a delivery is half-counted', VISIBLE + `
    state.qs.add['probe-sku']=3;`, [
    ['mUnsavedWork() misses a pending count', 'mUnsavedWork()===true'],
    ['the repaint would take the count away', 'mAutoOK()===false'],
    ['and the update it deferred is still owed', '(_mLive.dirty=false, mLiveNudge(), _mLive.dirty===true)'],
  ]],

  /* A guard that never lifts is a board that never refreshes — the complaint
     again, one level down. */
  ['and the guard lifts again once the count is banked', VISIBLE + `
    state.qs.add['probe-sku']=3; window.__blocked=mAutoOK(); delete state.qs.add['probe-sku'];`, [
    ['it was refused while the count stood', 'window.__blocked===false'],
    ['it is allowed once the count is gone', 'mAutoOK()===true'],
  ]],

  ['not on top of a pull the operator is already holding', VISIBLE + `
    state.refreshing=true;`, [
    ['two refreshes would run at once', 'mAutoOK()===false'],
  ]],

  ['a nudge that CAN run is debounced rather than fired at once', VISIBLE + `
    _mLive.dirty=false; _mLive.debounce=null; mLiveNudge(); mLiveNudge(); mLiveNudge();`, [
    ['a burst was not coalesced into one refresh', '_mLive.debounce!==null'],
    ['and nothing was left owed', '_mLive.dirty===false'],
  ]],
], { settle: 0 });
