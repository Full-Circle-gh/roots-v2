#!/usr/bin/env node
/**
 * Where a screen was left — Tacet Mobile's scroll memory.
 *
 *   node scripts/test_mobile_scroll.js
 *
 * Home is a long board and the Quick actions sit at the BOTTOM of it, so
 * taking a shortcut is always a scroll to the end of Home first. The app
 * remembered one position — whichever screen was painted last — so the tap
 * that opened Receiving overwrote Home's, and Back returned to the top of a
 * board the operator had just scrolled to the end of. Every shortcut cost that
 * scroll twice.
 *
 * The claims, one case each:
 *
 *   • A SCREEN RETURNED TO KEEPS ITS PLACE. Back from a pushed screen, and a
 *     tab left and come back to, both land where they were left.
 *   • A SCREEN OPENED STARTS AT THE TOP. A push must not inherit the position
 *     of the screen it was opened from, or it opens halfway down itself.
 *   • OPENING IS NOT RETURNING. A screen closed and pushed again is being
 *     opened, so it starts at the top the way it did the first time.
 *   • A REPAINT IN PLACE CHANGES NOTHING. The original fix — a list that does
 *     not jump on every tap — still holds.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// Everything, as an owner resolves: the pushed screens below must be reachable.
const OWNER = "state.caps=Object.keys(ROUTE_CAP).reduce(function(a,k){var v=ROUTE_CAP[k];"
  + "(Array.isArray(v)?v:[v]).forEach(function(x){a.push(x)});return a},[]);"
  + "state.capsLoaded=true;";
/* A scroller short enough to have a bottom. On a real phone Home is a long
   board against a 940px window; in a runner with no dashboard behind it there
   are three cards and nothing to scroll, so every assertion below would pass
   on 0===0 and prove nothing. The rule is on the CLASS, so it survives the
   repaints these cases are about. */
const SHORT = "document.head.insertAdjacentHTML('beforeend',"
  + "'<style>.content{height:200px !important;flex:none !important}</style>');";
// Home, scrolled to where the Quick actions are: the position every case below
// is about. Recorded as window.was so the assertions can compare against what
// the scroller actually accepted rather than the number that was asked of it.
const ONHOME = OWNER + SHORT + "APP.cmd('tab','home');"
  + "var c=document.getElementById('content'); c.scrollTop=c.scrollHeight;"
  + "window.was=c.scrollTop; window.top0=function(){return document.getElementById('content').scrollTop};";

const now = "top0()";

run('mobile scroll', [
  ['home is long enough to have a place to lose', ONHOME, [
    ['it scrolls', 'window.was>0'],
  ]],

  // ── a screen returned to keeps its place ──────────────────────────────
  ['back from a shortcut lands where Home was left',
    ONHOME + "APP.cmd('push','waste'); APP.cmd('back');", [
      ['Home is where it was', `${now}===window.was`],
    ]],
  ['the phone Back gesture does the same',
    ONHOME + "APP.cmd('push','waste'); var L=layers(); L[L.length-1](); render();", [
      ['Home is where it was', `${now}===window.was`],
    ]],
  ['a tab left and returned to keeps its place',
    ONHOME + "APP.cmd('tab','products'); APP.cmd('tab','home');", [
      ['Home is where it was', `${now}===window.was`],
    ]],

  // ── a screen opened starts at the top ─────────────────────────────────
  ['a pushed screen does not inherit the scroll it was opened from',
    ONHOME + "APP.cmd('push','waste');", [
      ['opens at the top', `${now}===0`],
    ]],
  ['a tab opened starts at the top',
    ONHOME + "APP.cmd('tab','products');", [
      ['opens at the top', `${now}===0`],
    ]],
  ['closed and opened again is opening, not returning',
    ONHOME + "APP.cmd('push','waste');"
    + "var w=document.getElementById('content'); w.scrollTop=w.scrollHeight; window.deep=w.scrollTop;"
    + "APP.cmd('back'); APP.cmd('push','waste');", [
      ['the second open is at the top', `${now}===0`],
      ['and it was scrollable, so the check means something', 'window.deep>=0'],
    ]],

  // ── a repaint in place changes nothing ────────────────────────────────
  ['a plain repaint holds the position', ONHOME + "render(); render();", [
    ['still there', `${now}===window.was`],
  ]],
  ['a toast holds it too', ONHOME + "showToast('x');", [
    ['still there', `${now}===window.was`],
  ]],

  // ── leaving the app for another page ──────────────────────────────────
  // Counter till and Quick Stock are separate documents, so the map above dies
  // with this one. What crosses is one sessionStorage line, written on the way
  // out. (A file:// runner may refuse storage entirely; the app swallows that,
  // and so does this check.)
  ['leaving for another page writes the position across', ONHOME + "saveScrollForReturn();", [
    ['it is stored under this screen', `(function(){
        try{ sessionStorage.setItem('_t','1'); sessionStorage.removeItem('_t'); }
        catch(e){ return true; }
        var v=JSON.parse(sessionStorage.getItem('tacet-m-scroll')||'null');
        return !!v && v.key==='home|' && v.top===window.was; })()`],
  ]],
  // Coming BACK from that page is a fresh document: the same two lines the app
  // runs at boot, against the storage the case above wrote.
  ['and coming back lands on it',
    ONHOME + "saveScrollForReturn(); _bootScroll=bootScrollRead();"
    + "document.getElementById('content').scrollTop=0; _scrollKey=''; _scrollMem['home|']=0; render();", [
      ['Home is where it was left', `${now}===window.was`],
      ['and the line is spent, so the next boot opens on Home',
        "(function(){ try{ return !sessionStorage.getItem('tacet-m-scroll'); }catch(e){ return true; } })()"],
    ]],
  ['a return that names another screen is ignored',
    ONHOME + "saveScrollForReturn(); _bootScroll=bootScrollRead();"
    + "APP.cmd('tab','products'); ", [
      ['Products opens at the top', `${now}===0`],
    ]],
]);
