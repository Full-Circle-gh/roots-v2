#!/usr/bin/env node
/**
 * The navigation an operator is actually given — Tacet Mobile's tab bar, its
 * More list and its search index, filtered by capability.
 *
 *   node scripts/test_mobile_nav.js
 *
 * Why these assertions and not others. Until this filter existed, TAB_META and
 * MORE_GROUPS were static: every operator got the owner's app, five tabs and
 * thirty rows, whatever their role could reach. The ways that can go wrong are
 * all quiet, and each has a case here:
 *
 *   • THE OWNER MUST NOT MOVE. A gate that narrows the wrong people is worse
 *     than no gate. Null caps (a resolution hiccup, a stale session) and a full
 *     cap array must both leave the five destinations exactly as they were.
 *   • A NARROWED ROLE MUST NOT LAND ON HOME. Home is a board of revenue, and
 *     the app opens on it. An operator without dashboard:view was shown the one
 *     screen their role exists to exclude.
 *   • A BAR OF ONE FOLDER IS NOT NAVIGATION. A role holding none of the four
 *     destinations would get a tab bar containing only "More" — one button over
 *     a list of the two things they do all day.
 *   • THE GATE MUST HOLD ON EVERY ROUTE IN. Hiding a row is not the same as
 *     refusing it: push(), the tab command and the ?to= launcher shortcut can
 *     each name a screen the operator cannot reach.
 *   • RECEIVING IS GATED ON RECEIVE, NOT VIEW. Its save is purchasing:receive
 *     server-side; offered to a viewer it is a screen whose only action 403s.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// The two tools a kitchen account that also books deliveries in actually holds.
const KITCHEN = "state.caps=['quickstock:add','purchasing:receive'];";
// Everything, as an owner resolves.
const OWNER = "state.caps=Object.keys(ROUTE_CAP).reduce(function(a,k){var v=ROUTE_CAP[k];"
  + "(Array.isArray(v)?v:[v]).forEach(function(x){a.push(x)});return a},[]);";

const bar = "document.querySelector('.tabbar').innerText.replace(/\\s+/g,' ')";
const body = "txt('content').replace(/\\s+/g,' ')";
// The bar is the operator's whole navigation, so its BUTTON COUNT is the claim,
// not just which words appear in it.
const bars = "document.querySelectorAll('.tabbar button').length";

run('mobile nav', [
  // ── the owner does not move ───────────────────────────────────────────
  ['caps unknown — the five destinations stand', "state.caps=null;render();", [
    ['Home', `${bar}.indexOf('Home')>-1`],
    ['Orders', `${bar}.indexOf('Orders')>-1`],
    ['Customers', `${bar}.indexOf('Customers')>-1`],
    ['Products', `${bar}.indexOf('Products')>-1`],
    ['More', `${bar}.indexOf('More')>-1`],
    ['five and no more', `${bars}===5`],
  ]],
  ['full caps — still exactly the five', OWNER + "render();", [
    ['five', `${bars}===5`],
    ['Home is one of them', `${bar}.indexOf('Home')>-1`],
    ['More is the last', `${bar}.indexOf('More')>-1`],
  ]],

  // ── the kitchen role: two tools, and only two ─────────────────────────
  ['a kitchen role gets its two tools and nothing else', KITCHEN + "render();", [
    ['two buttons', `${bars}===2`],
    ['Add stock', `${bar}.indexOf('Add stock')>-1`],
    ['Receiving', `${bar}.indexOf('Receiving')>-1`],
    ['no Home', `${bar}.indexOf('Home')===-1`],
    ['no Orders', `${bar}.indexOf('Orders')===-1`],
    ['no Customers', `${bar}.indexOf('Customers')===-1`],
    ['no Products', `${bar}.indexOf('Products')===-1`],
    ['and no More to hide them behind', `${bar}.indexOf('More')===-1`],
  ]],
  ['in Chinese', KITCHEN + "LANG='cn';render();", [
    ['加库存', `${bar}.indexOf('加库存')>-1`],
    ['收货', `${bar}.indexOf('收货')>-1`],
    ['two', `${bars}===2`],
  ]],
  ['it opens on Receiving, never on the revenue board',
    KITCHEN + "state.tab='home';landOnSomethingReachable();render();", [
      ['the stack is on Receiving', "state.stack.length===1 && state.stack[0].route==='receiving'"],
      ['and Home is not what is painted', `${body}.indexOf('Revenue')===-1`],
    ]],
  ['a store stocker, whose only tool leaves this app',
    "state.caps=['quickstock:recount'];render();", [
      ['one button', `${bars}===1`],
      ['named for the mode they land in', `${bar}.indexOf('Quick stock')>-1`],
      ['not the kitchen wording', `${bar}.indexOf('Add stock')===-1`],
    ]],

  // ── the gate holds on every route in ──────────────────────────────────
  ['a hidden screen cannot be reached anyway', KITCHEN + "push('coupons');render();", [
    ['push refuses it', "state.stack.length===0"],
  ]],
  // state.tab starts life as 'home', so "it is still home" would pass whether
  // the command was refused or obeyed. Start somewhere reachable and prove the
  // command does not move them off it.
  ['nor by the tab command',
    KITCHEN + "state.tab='more';state.stack=[];APP.cmd('tab','home');render();", [
      ['the tab does not move', "state.tab==='more'"],
      ['and the revenue board is not painted', `${body}.indexOf('Revenue')===-1`],
    ]],
  ['nor by a launcher shortcut kept from a wider role',
    KITCHEN + "state.stack=[{route:'coupons',title:SUBS.coupons.title}];landOnSomethingReachable();render();", [
      ['the deep link is dropped', "state.stack.every(function(f){return f.route!=='coupons'})"],
      ['and they land on their own tool', "state.stack.length===1 && state.stack[0].route==='receiving'"],
    ]],

  // ── the More list and the search index read the same filter ───────────
  ['More holds only what the role reaches',
    "state.caps=['orders:view','delivery:view'];state.tab='more';state.stack=[];render();", [
      ['Delivery is there', `${body}.indexOf('Delivery')>-1`],
      ['Coupons is not', `${body}.indexOf('Coupons')===-1`],
      ['nor the owner’s setup checklist', `${body}.indexOf('Open your store')===-1`],
      ['Orders kept its tab, so More is a folder again', `${bar}.indexOf('Orders')>-1 && ${bar}.indexOf('More')>-1`],
    ]],
  ['the jump list cannot offer what the nav hides', KITCHEN + "render();", [
    ['Receiving is offered', "searchIndex().some(function(x){return x.p[0]==='Receiving'})"],
    ['Coupons is not', "!searchIndex().some(function(x){return x.p[0]==='Coupons'})"],
    ['nor Home', "!searchIndex().some(function(x){return x.p[0]==='Home'})"],
  ]],

  // ── receiving is gated on the verb, not the view ──────────────────────
  ['a buyer who may look but not receive',
    "state.caps=['purchasing:view'];state.tab='more';state.stack=[];render();", [
      ['Purchasing is theirs', `${body}.indexOf('Purchasing')>-1`],
      ['Receiving is not — its only action would 403', `${body}.indexOf('Receiving')===-1`],
    ]],

  // ── narrowed to nothing ───────────────────────────────────────────────
  ['a role this app holds nothing for says so',
    "state.caps=['billing:view'];state.tab='more';state.stack=[];render();", [
      ['it says so', `${body}.indexOf('Nothing here for you yet')>-1`],
      ['and names who can widen it', `${body}.indexOf('manages your team')>-1`],
      ['with no tab bar to imply otherwise', "!document.querySelector('.tabbar')"],
    ]],
]);
