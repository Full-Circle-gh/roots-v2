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
 *   • A ROLE IS NOT A FIXED NUMBER OF SLOTS. A role holding none of the four
 *     destinations gets NO BAR: its tools are the home screen, a list, under
 *     the role's own name. A bar was tried and rejected — two tools fit in one,
 *     eight do not, and a bar that becomes "four plus More" has put back the
 *     lid this whole change removes.
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
  ['a kitchen role gets its two tools as its home, and no bar',
    KITCHEN + "landOnSomethingReachable();render();", [
      ['no tab bar at all', "!document.querySelector('.tabbar')"],
      ['Receiving is on the home list', `${body}.indexOf('Receiving')>-1`],
      ['so is Add stock', `${body}.indexOf('Add stock')>-1`],
      ['no Home board', `${body}.indexOf('Revenue')===-1`],
      ['no Orders', `${body}.indexOf('Orders')===-1`],
      ['no Customers', `${body}.indexOf('Customers')===-1`],
      ['it is not titled after a bar that is not there', "txt('content').indexOf('More')===-1"],
    ]],
  ['the home is named for the role, not for the app',
    KITCHEN + "state.me={name:'R',role:'kitchen',roleName:{en:'Kitchen',cn:'后厨'}};landOnSomethingReachable();render();", [
      ['English', `${body}.indexOf('Kitchen')>-1`],
    ]],
  ['in Chinese', KITCHEN + "LANG='cn';state.me={name:'R',role:'kitchen',roleName:{en:'Kitchen',cn:'后厨'}};landOnSomethingReachable();render();", [
    ['the role names the home', `${body}.indexOf('后厨')>-1`],
    ['加库存', `${body}.indexOf('加库存')>-1`],
    ['收货', `${body}.indexOf('收货')>-1`],
  ]],
  ['it lands on the list, not inside one of the tools',
    KITCHEN + "state.tab='home';landOnSomethingReachable();render();", [
      ['nothing is pushed', "state.stack.length===0"],
      ['both tools are in reach', `${body}.indexOf('Receiving')>-1 && ${body}.indexOf('Add stock')>-1`],
      ['and the revenue board is not painted', `${body}.indexOf('Revenue')===-1`],
    ]],
  ['a tool comes back to the home by name, never to "More"',
    KITCHEN + "state.me={name:'R',role:'kitchen',roleName:{en:'Kitchen',cn:'后厨'}};push('receiving');render();", [
      ['the back link names the home', `${body}.indexOf('Kitchen')>-1`],
      ['not More', `${body}.indexOf('More')===-1`],
    ]],
  /* ── The kitchen queue's row ───────────────────────────────────────────
     The queue shipped as a tile on /stock's Stock home. A kitchen operator
     whose role puts them in THIS app never sees that home — they see the list
     above, where "Add stock" is not a name anybody reads as "the orders waiting
     for you". Ash, on a phone, with an order sitting unseen: "this all i see in
     the kitchen role on mobile."

     The row is gated on `restock:fulfil`, the capability the queue's own writes
     are gated on, so it cannot appear for somebody whose first tap 403s — which
     is also why the two caps above do NOT get it. */
  ['the queue is not offered to a role that cannot fulfil',
    KITCHEN + "landOnSomethingReachable();render();", [
      ['no queue row', `${body}.indexOf('Kitchen queue')===-1`],
      ['the two tools they do hold are untouched',
       `${body}.indexOf('Receiving')>-1 && ${body}.indexOf('Add stock')>-1`],
    ]],
  ['a kitchen role that CAN fulfil gets the queue',
    "state.caps=['quickstock:add','restock:fulfil'];landOnSomethingReachable();render();", [
      ['the row is there', `${body}.indexOf('Kitchen queue')>-1`],
      ['and Add stock beside it', `${body}.indexOf('Add stock')>-1`],
      ['still no board', `${body}.indexOf('Revenue')===-1`],
    ]],
  ['in Chinese', "LANG='cn';state.caps=['quickstock:add','restock:fulfil'];landOnSomethingReachable();render();", [
    ['厨房制作队列', `${body}.indexOf('厨房制作队列')>-1`],
  ]],
  // It leaves this app for /stock, where the queue lives, and says which screen
  // it wants — a row that lands on a launcher is a signpost, not a door.
  ['the row leaves for the queue itself, not the launcher',
    "state.caps=['quickstock:add','restock:fulfil'];landOnSomethingReachable();render();", [
      ['it carries the deep link',
       "moreRowsFlat().some(function(r){return r.key==='kitchenq' && r.href==='/stock?go=queue'})"],
    ]],

  ['a store stocker, whose only tool leaves this app',
    "state.caps=['quickstock:recount'];landOnSomethingReachable();render();", [
      ['no bar', "!document.querySelector('.tabbar')"],
      ['named for the mode they land in', `${body}.indexOf('Quick stock')>-1`],
      ['not the kitchen wording', `${body}.indexOf('Add stock')===-1`],
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
      ['and they land on their own home', "state.stack.length===0 && state.tab==='more'"],
    ]],

  // ── the More list and the search index read the same filter ───────────
  ['More holds only what the role reaches',
    "state.caps=['orders:view','delivery:view'];state.tab='more';state.stack=[];render();", [
      ['Delivery is there', `${body}.indexOf('Delivery')>-1`],
      ['Coupons is not', `${body}.indexOf('Coupons')===-1`],
      ['nor the owner’s setup checklist', `${body}.indexOf('Open your store')===-1`],
      ['Orders kept its tab, so More is a folder again', `${bar}.indexOf('Orders')>-1 && ${bar}.indexOf('More')>-1`],
    ]],
  // ── the counter till needs BOTH caps, and it is the only row that does ──
  // Its Confirm posts the ordinary manual order, which cap-routes gates on
  // orders:edit. Offered on till:use alone it is Receiving's bug wearing a
  // different label: a screen whose only action 403s — except this one 403s
  // with a customer standing at the counter and a basket already rung up.
  ['a cashier holding the pair gets the till',
    "state.caps=['till:use','orders:edit','orders:view'];state.tab='more';state.stack=[];render();", [
      ['the row is there', `${body}.indexOf('Counter till')>-1`],
      ['and the jump list offers it', "searchIndex().some(function(x){return x.p[0]==='Counter till'})"],
      ['it leaves this app rather than pushing a screen',
        "moreRowsFlat().some(function(r){return r.key==='till'&&r.href==='/till'})"],
    ]],
  ['till:use without orders:edit is not a till',
    "state.caps=['till:use','orders:view'];state.tab='more';state.stack=[];render();", [
      ['the row is gone', `${body}.indexOf('Counter till')===-1`],
      ['the jump list does not offer it either',
        "!searchIndex().some(function(x){return x.p[0]==='Counter till'})"],
      ['and push refuses it', "push('till'),state.stack.length===0"],
    ]],
  // The mirror of the case above: order editing on its own is not a till
  // either. Without this, granting orders:edit alone would quietly hand every
  // order desk in the business a counter screen.
  ['orders:edit without till:use is not a till either',
    "state.caps=['orders:edit','orders:view'];state.tab='more';state.stack=[];render();", [
      ['the row is gone', `${body}.indexOf('Counter till')===-1`],
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

  // ── the boot flash ────────────────────────────────────────────────────
  // caps null means "all allowed", which is right for a resolution hiccup and
  // wrong before anyone has asked. The app painted at once, so a narrowed
  // operator got the whole of Tacet for as long as /api/backend/me took, then
  // watched it collapse to their two tools — on every open, and on every Back
  // from Quick Stock, which is a full page load.
  //
  // The probe runs on file://, where capsLoaded starts TRUE by design: there is
  // no server to ask. So these cases put the flag back to where a real
  // deployment starts and assert on that.
  ['before the app knows who is looking, it paints nothing it might have to take back',
    "state.capsLoaded=false;state.caps=null;render();", [
      ['no tab bar', "!document.querySelector('.tabbar')"],
      ['no Home board', "document.getElementById('app').innerText.indexOf('Revenue')===-1"],
      ['not one destination named', "document.getElementById('app').innerText.indexOf('Customers')===-1"],
      ['the mark holds the screen', "!!document.querySelector('#app svg')"],
    ]],
  // The hold RELEASES however the read ends — a 401, a network error, or a
  // file:// page with no server behind it at all. That last one is this probe,
  // so reaching any of these assertions at all is the proof: loadMe's finally
  // ran, and the app is not sitting on the mark.
  ['and it releases when there is nobody to ask', "render();", [
    ['the hold is over', "state.capsLoaded===true"],
    ['the app painted', `${bars}===5`],
    ['on its sample data, as the static preview always did', `${body}.length>0`],
  ]],

  // ── the two things every operator needs, whatever their role ──────────
  // Sign out lived only inside Settings, which is capability-gated, so the one
  // action belonging to no capability was taken away from exactly the operators
  // with the fewest other ways out. The Account row pushed Settings
  // unconditionally too — a chevron promising a screen push() then refused.
  ['a narrowed operator can still sign out', KITCHEN + "state.overflow=true;render();", [
    ['the menu offers it', "document.querySelector('.sheet').innerText.indexOf('Sign out')>-1"],
    ['it names who is signed in', "document.querySelector('.sheet').innerText.indexOf('Account')>-1"],
    ['with no chevron promising a Settings they cannot open',
     "!document.querySelector('.sheet button[onclick*=\"push\\',\\'settings\"]')"],
  ]],
  ['an operator who has Settings still reaches it from there',
    "state.caps=['settings:shop','orders:view'];state.overflow=true;render();", [
      ['Account still goes somewhere', "document.querySelector('.sheet').innerHTML.indexOf(\"push','settings'\")>-1"],
      ['and Sign out is there too', "document.querySelector('.sheet').innerText.indexOf('Sign out')>-1"],
    ]],

  // ── an order is not everyone's work ───────────────────────────────────
  // This polled, dinged and toasted "New order" for every operator, because it
  // predates roles reaching this app at all: a kitchen account was woken by a
  // sale it cannot see, cannot open and cannot act on.
  ['a kitchen account is not woken by a sale it cannot see',
    KITCHEN + "state.live=true;state.ordersUnseen=3;", [
      ['the poll does not run', "pollUnseenOrders()===undefined && !window.__polled"],
      ['and no dot claims work that is not theirs', "unseenOrders()===false"],
    ]],
  ['an order desk still hears its orders',
    "state.caps=['orders:view'];state.ordersUnseen=2;", [
      ['the dot lights', "unseenOrders()===true"],
    ]],

  // ── narrowed to nothing ───────────────────────────────────────────────
  ['a role this app holds nothing for says so',
    "state.caps=['billing:view'];state.tab='more';state.stack=[];render();", [
      ['it says so', `${body}.indexOf('Nothing here for you yet')>-1`],
      ['and names who can widen it', `${body}.indexOf('manages your team')>-1`],
      ['with nothing else on the screen to imply otherwise', "!document.querySelector('.tabbar')"],
    ]],
]);
