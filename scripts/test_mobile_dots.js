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
];

run('attention dots', CASES);
