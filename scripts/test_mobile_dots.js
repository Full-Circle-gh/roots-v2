#!/usr/bin/env node
/**
 * The two attention dots, and whether they can ever go out.
 *
 *   node scripts/test_mobile_dots.js
 *
 * Reported from the shop floor: "the green light in orders and feedback never
 * shut down. in feedback can shut down but once page refresh it goes back
 * again." Both were true, for two different reasons.
 *
 *   ORDERS read DB.orders — the boot prefetch's snapshot, written once and
 *   never again, while the list an operator reads and taps is state.ordersView.
 *   Opening every order on the screen changed nothing the dot could see.
 *
 *   THE INBOX counted reviews missing from an in-memory Set. A reload empties a
 *   Set, so "mark all read" lasted exactly as long as the page did — and it
 *   counted reviews only, though the dot sits on a button that opens both
 *   reviews and feedback. The desktop has always used a last-seen TIMESTAMP in
 *   localStorage plus two server endpoints that count what arrived after it.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const ROWS = `DB.orders=[]; state.ordersView=[
  {id:'RT-…047',_id:1,ch:'miniapp',cust:['Chen','陈'],total:'¥312',placed:'2:22 PM',
   status:['Paid','已付'],kind:'paid',isNew:true,ship:['Guangzhou','广州'],items:[[1,'x','¥1']],
   pay:['WeChat','微信'],addr:['a','a'],phone:'1',fulfil:['T','T'],route:['n','n'],breakdown:[]},
  {id:'RT-…046',_id:2,ch:'web',cust:['Sarah','Sarah'],total:'¥186',placed:'2:07 PM',
   status:['Paid','已付'],kind:'paid',isNew:false,ship:['Guangzhou','广州'],items:[[1,'x','¥1']],
   pay:['WeChat','微信'],addr:['a','a'],phone:'1',fulfil:['T','T'],route:['n','n'],breakdown:[]}];
  state.liveOrders=state.ordersView;`;

const dotOn = (tab) =>
  `[].slice.call(document.querySelectorAll('.tabbar button')).some(function(b){` +
  `return b.innerText.trim().indexOf(${JSON.stringify(tab)})===0 && b.querySelector('span span[style*="border-radius:50%"]');})`;
// The same 6px dot, on a row of the More list rather than on the folder.
const rowDot = (label) =>
  `[].slice.call(document.querySelectorAll('#content .row')).some(function(b){` +
  `return b.innerText.trim().indexOf(${JSON.stringify(label)})===0 && b.querySelector('span[style*="border-radius:50%"]');})`;

const CASES = [
  ['an unread order lights the Orders dot', ROWS + `APP.cmd('tab','orders');`, [
    ['the dot is on', dotOn('Orders')],
  ]],
  ['opening it puts the dot out — on the tap, not on the next reload',
   ROWS + `APP.cmd('tab','orders'); APP.cmd('openOrder','RT-…047'); APP.cmd('closeOrder');`, [
    // The dot used to read a snapshot taken at boot, so this changed nothing.
    ['the dot is off',              `!(${dotOn('Orders')})`],
    ['and the row is marked seen',  `state.ordersView[0].isNew === false`],
    ['in both lists',               `state.liveOrders[0].isNew === false`],
  ]],
  ['a list with nothing unread has no dot',
   ROWS.replace('isNew:true', 'isNew:false') + `APP.cmd('tab','orders');`, [
    ['no dot', `!(${dotOn('Orders')})`],
  ]],
  ['the inbox dot is the server\'s count, not a Set',
   `state.inboxUnseen=3; APP.cmd('tab','home'); render();`, [
    ['the More dot is on', dotOn('More')],
    ['and so is the inbox mark in the header',
     `!!document.querySelector('#app button[aria-label="Inbox"], #app [aria-label="Inbox"]')`],
  ]],
  ['opening the inbox stamps a last-seen that OUTLIVES the page',
   `state.inboxUnseen=3; APP.cmd('tab','home'); APP.cmd('push','inbox');`, [
    ['the count is cleared',   `state.inboxUnseen === 0`],
    // This is the half that was missing: a Set does not survive a reload, a
    // localStorage stamp does.
    ['and written to storage', `!!localStorage.getItem('tacet.m.inboxSeen')`],
    ['as a timestamp',         `/^\\d{4}-\\d{2}-\\d{2}T/.test(localStorage.getItem('tacet.m.inboxSeen'))`],
  ]],
  ['a stamped last-seen means the next load asks the server "since when"',
   `localStorage.setItem('tacet.m.inboxSeen','2026-08-22T09:00:00.000Z');
    window.__sent=[]; var _f=window.fetch;
    window.fetch=function(u,o){ window.__sent.push(String(u)); return _f(u,o); };
    state.inboxPolled=false; loadInboxUnseen(true);`, [
    ['reviews are asked with the stamp',
     `window.__sent.some(function(u){return u.indexOf('/reviews/unseen-count?since=2026-08-22')>=0})`],
    ['feedback too — the dot covers both, and the old Set covered only reviews',
     `window.__sent.some(function(u){return u.indexOf('/feedback/unseen-count?since=2026-08-22')>=0})`],
  ]],

  /* ── The third dot: the kitchen finished what the warehouse asked for ─────
     A warehouse account raises a kitchen request from /stock and, until this,
     heard nothing in this app ever again: warehouse→kitchen closes at
     'prepared', so there is no delivery to watch, and the only announcement was
     a push — one moment, on one phone, regularly in a pocket or on silent. */
  ['a request the kitchen finished lights the More dot',
   `state.kitchenReady=2; APP.cmd('tab','home'); render();`, [
    ['the More dot is on', dotOn('More')],
  ]],
  ['and the row inside More says which one it meant',
   `state.kitchenReady=2; APP.cmd('tab','more');`, [
    // Thirty rows behind one folder dot is a guessing game. On a warehouse role
    // with no tab bar at all this list IS the home screen, so the row's dot is
    // the only one there is.
    /* IT IS THE READY LIST'S ROW, NOT TRANSFERS. The dot sat on Transfers while
       that row was the only door to the ready list — /stock's launcher held it,
       and Transfers was the way in. §48 gave the list a row of its own and then
       removed the launcher, so the dot moved to the row it was always about. */
    ['Ready from the kitchen carries the dot', rowDot('Ready from the kitchen')],
    // Counted rather than spot-checked: "Purchasing has no dot" would also be
    // true of a More list that failed to render a single row.
    ['and it is the only row that does',
     `[].slice.call(document.querySelectorAll('#content .row'))` +
     `.filter(function(b){return b.querySelector('span[style*="border-radius:50%"]')}).length === 1`],
    ['on a list that really has other rows',
     `document.querySelectorAll('#content .row').length > 5`],
  ]],
  ['nothing waiting is no dot',
   `state.kitchenReady=0; APP.cmd('tab','more'); render();`, [
    ['not on the folder', `!(${dotOn('More')})`],
    ['nor on the row',    `!(${rowDot('Ready from the kitchen')})`],
  ]],
  ['an operator who cannot open the ready list is never told about it',
   // A dot promising work over a door this role cannot open — the same rule the
   // inbox dot keeps.
   `state.caps=['dashboard:view']; state.kitchenReady=2; APP.cmd('tab','home'); render();`, [
    ['no folder dot', `!(${dotOn('More')})`],
    ['and readyFromKitchen() answers zero', `readyFromKitchen() === 0`],
  ]],
  ['the count is the server\'s fact, not this phone\'s memory',
   `window.__sent=[]; var _f=window.fetch;
    window.fetch=function(u,o){ window.__sent.push(String(u));
      return Promise.resolve({ok:true,json:function(){return Promise.resolve({success:true,data:{count:3,latest:null}})}}); };
    state.kitchenReady=0; pollKitchenReady();`, [
    // No ?since= and no localStorage stamp: a server-side `seen_at` is what
    // clears it, so one person opening the list in /stock puts the dot out on
    // every other phone. Nothing is collected — the kitchen shelves what it
    // makes and records the stock itself, so this is news, not a job.
    ['it asks the shared endpoint',
     `window.__sent.some(function(u){return u.indexOf('/api/restock/kitchen-ready')>=0})`],
    ['with no per-device stamp',
     `!window.__sent.some(function(u){return u.indexOf('since=')>=0})`],
    ['and takes the answer', `state.kitchenReady === 3`],
   ]],
  ['a role that cannot ask is never polled',
   `state.caps=['dashboard:view']; window.__sent=[]; var _f=window.fetch;
    window.fetch=function(u,o){ window.__sent.push(String(u)); return _f(u,o); };
    pollKitchenReady();`, [
    ['no request is made',
     `!window.__sent.some(function(u){return u.indexOf('/api/restock/kitchen-ready')>=0})`],
   ]],
];

/* One settle for the whole run: the kitchen-ready case starts a fetch, and a
   promise continuation cannot be asserted on in the task that began it. */
run('attention dots', CASES, { settle: 150 });
