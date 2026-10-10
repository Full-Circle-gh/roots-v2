#!/usr/bin/env node
/**
 * §446 — the phone's More list, shortened.
 *
 *   node scripts/test_mobile_more_fold.js
 *
 * Asked by Ash off the live phone: "scrolling too long. also once there is a
 * green dot on more I need to look for what it is by scrolling endlessly".
 * An owner's More held about fifty-four rows, and the three rows the More dot
 * can mean sat around rows 15, 30 and 35.
 *
 *   A. NEEDS YOU, FIRST. Whatever is lighting the More dot is drawn at the top,
 *      above the questions, under Home's own heading. No dot, no card.
 *   B. GROUPS FOLD. Each headed group is one row; a tap opens it in place.
 *      All closed by default. Not on a role with no tab bar, where this list
 *      is the home screen.
 *   §447: "once go out from more fold again all automatic don't leave it
 *      open". Leaving More closes every group; nothing is stored.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// Everything, as an owner resolves — test_mobile_nav.js's fixture.
const OWNER = "state.caps=Object.keys(ROUTE_CAP).reduce(function(a,k){var v=ROUTE_CAP[k];"
  + "(Array.isArray(v)?v:[v]).forEach(function(x){a.push(x)});return a},[]);";
// A kitchen role holds none of the four tabs, so More is its home (flatNav).
const KITCHEN = "state.caps=['quickstock:add','purchasing:receive'];";
const QUIET = "state.inboxUnseen=0;state.kitchenReady=0;state.pickWaiting=0;";
const MORE = "state.tab='more';state.stack=[];render();";

const body = "txt('content').replace(/\\s+/g,' ')";
const needs = "(function(){var el=document.getElementById('mMoreNeeds');return el?el.innerText.replace(/\\s+/g,' '):''})()";
const header = (h) => `document.querySelector('#mMoreGroups [data-group=${JSON.stringify(h)}]')`;
const headerDot = (h) => `!!${header(h)}.querySelector('span[style*="border-radius:50%"]')`;
const toggle = (h) => `APP.cmd('toggleMoreGroup',${JSON.stringify(h)});`;
const stored = "localStorage.getItem('tacet-m-more-open')";
const allClosed = "[].slice.call(document.querySelectorAll('#mMoreGroups [data-group]'))"
  + ".every(function(b){return b.getAttribute('aria-expanded')==='false'})";

const CASES = [
  /* ── B: folded by default ───────────────────────────────────────────────── */
  ['an owner opens More to folded groups',
   OWNER + QUIET + MORE, [
    ['the groups are drawn as one folded list', `!!document.getElementById('mMoreGroups')`],
    ['every heading is there', "MORE_GROUPS.filter(function(g){return g.h}).every(function(g){return "
      + "!!document.querySelector('#mMoreGroups [data-group=\"'+g.h[0]+'\"]')})"],
    ['each says it is closed', "[].slice.call(document.querySelectorAll('#mMoreGroups [data-group]'))"
      + ".every(function(b){return b.getAttribute('aria-expanded')==='false'})"],
    ['no tool row is drawn inside a closed group', `${body}.indexOf('Coupons')===-1 && ${body}.indexOf('Purchasing')===-1`],
    ['Settings has no heading to fold under, so it stays a row', `${body}.indexOf('Settings')>-1`],
    ['the list is short now', "document.querySelectorAll('#content .row').length < 20"],
   ]],
  ['a tap opens one group in place',
   OWNER + QUIET + MORE + toggle('Marketing'), [
    ['its tools are drawn', `${body}.indexOf('Coupons')>-1 && ${body}.indexOf('Flash sales')>-1`],
    ['it says it is open', `${header('Marketing')}.getAttribute('aria-expanded')==='true'`],
    ['no other group opened with it', `${body}.indexOf('Purchasing')===-1`],
    ['and nothing is stored on the phone (§447)', `${stored}===null`],
   ]],
  ['a second tap closes it again',
   OWNER + QUIET + MORE + toggle('Marketing') + toggle('Marketing'), [
    ['its tools are gone', `${body}.indexOf('Coupons')===-1`],
   ]],

  /* ── §447: leaving More folds it again ─────────────────────────────────── */
  ['a repaint of More keeps an open group open',
   OWNER + QUIET + MORE + toggle('Marketing') + "render();render();", [
    ['still open', `${header('Marketing')}.getAttribute('aria-expanded')==='true'`],
   ]],
  ['another tab and back: all closed',
   OWNER + QUIET + MORE + toggle('Marketing') + toggle('Stock coming in')
     + "APP.cmd('tab','home');APP.cmd('tab','more');", [
    ['every group says closed', allClosed],
    ['no tool row is drawn', `${body}.indexOf('Coupons')===-1 && ${body}.indexOf('Purchasing')===-1`],
   ]],
  ['a tool opened from a group, then Back: all closed',
   OWNER + QUIET + MORE + toggle('Marketing')
     + "push('coupons');window.__onCoupons=state.stack.length===1;"
     + "APP.cmd('back');", [
    ['Coupons really opened, or this case proves nothing', "window.__onCoupons===true"],
    ['back on More', "state.tab==='more' && !state.stack.length"],
    ['every group says closed', allClosed],
    ['its tools are folded away', `${body}.indexOf('Coupons')===-1`],
   ]],
  ['a group stored by §446 does not come back',
   OWNER + QUIET + "localStorage.setItem('tacet-m-more-open',JSON.stringify(['Stock coming in']));state.moreOpen=null;" + MORE, [
    ['all closed', `${body}.indexOf('Purchasing')===-1`],
   ]],

  /* ── A: Needs you, first ───────────────────────────────────────────────── */
  ['nothing waiting is no card',
   OWNER + QUIET + MORE, [
    ['no Needs you card', `!document.getElementById('mMoreNeeds')`],
   ]],
  ['the kitchen finishing puts its row at the top',
   OWNER + QUIET + "state.kitchenReady=2;" + MORE, [
    ['the card is there, under Home’s heading', `${needs}.indexOf('Needs you')===0`],
    ['holding the row that lit the dot', `${needs}.indexOf('Ready from the kitchen')>-1`],
    ['and nothing that did not', `${needs}.indexOf('Inbox')===-1 && ${needs}.indexOf('Send to another shop')===-1`],
    ['above the questions', `${body}.indexOf('Needs you') < ${body}.indexOf('What do you need to do?')`],
    ['the row opens the ready list', `document.querySelector('#mMoreNeeds .row').getAttribute('onclick').indexOf('kitchenready')>-1`],
    ['its closed group carries the dot too', headerDot('Ask someone else')],
    ['and no other group does', "[].slice.call(document.querySelectorAll('#mMoreGroups [data-group]'))"
      + ".filter(function(b){return b.querySelector('span[style*=\"border-radius:50%\"]')}).length===1"],
   ]],
  ['opened, the group drops its dot because the row inside has its own',
   OWNER + QUIET + "state.kitchenReady=2;" + MORE + toggle('Ask someone else'), [
    ['no dot on the heading', `!(${headerDot('Ask someone else')})`],
    ['the row inside keeps it', "[].slice.call(document.querySelectorAll('#mMoreGroups .row'))"
      + ".some(function(b){return b.innerText.trim()==='Ready from the kitchen' && b.querySelector('span[style*=\"border-radius:50%\"]')})"],
   ]],
  ['shops asking for stock puts Send to another shop at the top',
   OWNER + QUIET + "state.pickWaiting=2;" + MORE, [
    ['the row is in the card', `${needs}.indexOf('Send to another shop')>-1`],
    ['its group carries the dot', headerDot('Send it out')],
   ]],
  ['new reviews put the Inbox at the top, with its count',
   OWNER + QUIET + "state.inboxUnseen=3;" + MORE, [
    ['the row is in the card', `${needs}.indexOf('Inbox')>-1`],
    ['with the number §293 gave it', "document.querySelector('#mMoreNeeds .row .num').innerText.trim()==='3'"],
    ['its group carries the dot', headerDot('Messages and channels')],
   ]],
  ['the card and the More tab answer the same question',
   OWNER + QUIET + "state.kitchenReady=1;state.inboxUnseen=4;" + MORE, [
    ['the tab is lit', "tabDot('more')"],
    ['and the card holds exactly the rows that lit it',
     "document.querySelectorAll('#mMoreNeeds .row').length===moreRowsFlat().filter(moreRowWants).length"
      + " && document.querySelectorAll('#mMoreNeeds .row').length===2"],
   ]],
  ['a role that cannot open a row is never shown it in the card',
   // readyFromKitchen() is gated on the route, as the dot is.
   "state.caps=['dashboard:view','orders:view'];" + QUIET + "state.kitchenReady=2;" + MORE, [
    ['no card', `!document.getElementById('mMoreNeeds')`],
   ]],
  ['in Chinese',
   OWNER + QUIET + "LANG='cn';state.kitchenReady=2;" + MORE, [
    ['the heading is Home’s own pair', `${needs}.indexOf('需要处理')===0`],
    ['and the row is its own name', `${needs}.indexOf('厨房已完成')>-1`],
   ]],

  /* ── No tab bar: the list is the home screen, so it does not fold ───────── */
  ['a kitchen role keeps its tools in view',
   KITCHEN + QUIET + "landOnSomethingReachable();render();", [
    ['no folded list', `!document.getElementById('mMoreGroups')`],
    ['its tools are on the screen', `${body}.indexOf('Receive from a supplier')>-1 && ${body}.indexOf('Add stock')>-1`],
   ]],
];

run('§446 More fold', CASES);
