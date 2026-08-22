#!/usr/bin/env node
/**
 * Home — the first screen the app opens on, asserted against 03-dashboard.js.
 *
 *   node scripts/test_mobile_home.js
 *
 * Two things were wrong with it, and neither was a broken control.
 *
 *   • The "Today" tile fell back to ¥12,840 · 37 orders · ¥347 · 1,204
 *     visitors — four numbers typed into a mockup, under a heading that says
 *     Today, on the first screen the app opens. Any slow or failed
 *     /dashboard call put invented money in front of an operator, and
 *     "Revenue ¥12,840" is not a figure anyone reads twice.
 *   • Quick actions offered "Add product", "Create coupon", "Send broadcast".
 *     The phone can do none of the three; each opened a read-only list. They
 *     were not wired to noop, which is why they outlived that sweep, but they
 *     promise the same thing and break it the same way.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const KPIS = `state.liveKpis=[
  ['Revenue (all channels)','¥3,180','+12% vs a typical day'],
  ['Orders (storefront)','19','+3 vs a typical day'],
  ['Avg. order','¥167.37',''],
  ['New customers','4','−1 vs a typical day']];`;

const CASES = [
  ['before the dashboard answers', `APP.cmd('tab','home');`, [
    // The mock's four figures, gone. Each is asserted by its own value because
    // any one of them appearing means the fallback is back.
    ['no invented revenue',   `!txt('content').includes('12,840')`],
    ['no invented order count', `!/\\b37\\b/.test(txt('content'))`],
    ['no invented average',   `!txt('content').includes('¥347')`],
    ['no invented visitors',  `!txt('content').includes('1,204')`],
    ['the tile is still there, with its labels', `txt('content').includes('Revenue (all channels)') && txt('content').includes('New customers')`],
    ['saying it has no figure yet',              `txt('content').includes('—')`],
  ]],
  ['once it answers', `APP.cmd('tab','home'); ${KPIS} render();`, [
    ['the real revenue',   `txt('content').includes('¥3,180')`],
    ['the real orders',    `txt('content').includes('19')`],
    ['the real average',   `txt('content').includes('¥167.37')`],
    ['and the comparison', `txt('content').includes('vs a typical day')`],
  ]],
  ['quick actions are things the phone can actually do', `APP.cmd('tab','home');`, [
    // Each of these opens a screen that performs the action named.
    ['answer the inbox',       `txt('content').includes('Answer the inbox')`],
    ['tick a delivery in',     `txt('content').includes('Tick a delivery in')`],
    ['fix a price or a count', `txt('content').includes('Fix a price or a count')`],
    ['no "Add product"',       `!txt('content').includes('Add product')`],
    ['no "Create coupon"',     `!txt('content').includes('Create coupon')`],
    ['no "Send broadcast"',    `!txt('content').includes('Send broadcast')`],
  ]],
  ['the needs-you queue is the ops snapshot', `state.ops={
      unhandled:{count:3,items:[{placed_at:'2026-08-22 07:00:00'}]},
      refunds:{count:1,items:[]}, out_of_stock:{count:2}, low_stock:{count:5}};
    state.liveAttn={reviews:2}; APP.cmd('tab','home');`, [
    ['orders to start',       `txt('content').includes('Orders to start')`],
    ['refunds waiting',       `txt('content').includes('Refunds waiting')`],
    ['restock, counting what is OUT', `txt('content').includes('Restock needed') && txt('content').includes('out of stock, 5 running low')`],
    ['reviews, which the ops snapshot does not carry', `txt('content').includes('Reviews to reply')`],
  ]],
  ['a quiet shop shows no queue at all', `state.ops={unhandled:{count:0,items:[]}};
    state.liveAttn={}; APP.cmd('tab','home');`, [
    ['no "Needs you" heading', `!txt('content').includes('Needs you')`],
  ]],
];

// opsFires evaluates every argument before add() looks at its condition, so
// reading o.<key>.items inline threw on any payload missing a key — and a
// render that throws leaves the PREVIOUS screen on the glass, so Home would
// just look stale rather than broken. The server sends every key today; this
// case is here so that stays true by test rather than by luck.
CASES.push(['a partial ops payload does not take the screen down', `state.ops={unhandled:{count:2}};
  APP.cmd('tab','home');`, [
  ['the queue renders',        `txt('content').includes('Orders to start')`],
  ['and the rest of Home too', `txt('content').includes('Today')`],
]]);

// ── The two big lists, when the fetch fails ───────────────────────────────
// Both used to substitute their sample set — five orders, five customers, with
// real-looking numbers and names — and call it honest because the counts and
// the "load more" were suppressed. Nothing on the screen said they were
// samples. On a bad connection an operator could read them, tap into them and
// act on them.
CASES.push(['orders that did not load', `APP.cmd('tab','orders');
  state.ordersLoadErr='Could not load orders.'; state.ordersView=null; state.ordersLoading=false; render();`, [
  ['it says so',            `txt('content').includes('Could not load orders')`],
  ['reassures about the data', `txt('content').includes('Nothing is wrong with your orders')`],
  ['and offers a retry',    `txt('content').includes('Try again')`],
  ['NO SAMPLE ORDERS',      `!txt('content').includes('RT-') && !txt('content').includes('¥312')`],
  ['and not "no orders yet" either', `!txt('content').includes('No orders yet')`],
]]);

CASES.push(['customers that did not load', `APP.cmd('tab','customers');
  state.custLoadErr='Could not load customers.'; state.customers=[]; state.custLoaded=true; state.custLoading=false; render();`, [
  ['it says so',              `txt('content').includes('Could not load customers')`],
  ['and offers a retry',      `txt('content').includes('Try again')`],
  ['NO SAMPLE CUSTOMERS',     `!txt('content').includes('Chen Meiling') && !txt('content').includes('Sarah Lim')`],
  ['and not "no customers yet"', `!txt('content').includes('No customers yet')`],
]]);

// Every chip on Orders used to carry a count typed into the source — Pending 3,
// Paid 8, Preparing 6, Dispatched 11, Delivered 15, Mini app 28, All 47 — shown
// until the counts endpoint answered and forever if it did not. A badge on a
// filter chip is read as a fact about this shop.
CASES.push(['no chip invents a count', `APP.cmd('tab','orders');
  state.liveStatusCounts=null; state.liveChannelCounts=null; state.ordersLoading=false;
  state.ordersView=[]; render();`, [
  ['the chips are all there', `txt('content').includes('Pending') && txt('content').includes('Mini app')`],
  ['and none carries a number',
   "[].slice.call(document.querySelectorAll('#content .chip')).every(function(b){return !/\\d/.test(b.innerText)})"],
  ['nor does the status line', `!/waiting to ship/.test(txt('content'))`],
]]);

CASES.push(['real counts do appear', `APP.cmd('tab','orders');
  state.liveStatusCounts={pending_payment:2,paid:7}; state.liveChannelCounts={all:31,wechat:20};
  state.ordersLoading=false; state.ordersView=[]; render();`, [
  ['on the chips that have one',
   "[].slice.call(document.querySelectorAll('#content .chip')).some(function(b){return b.innerText.indexOf('Pending')>=0 && b.innerText.indexOf('2')>=0})"],
  ['including the totals',
   "[].slice.call(document.querySelectorAll('#content .chip')).some(function(b){return b.innerText.indexOf('All')>=0 && b.innerText.indexOf('31')>=0})"],
  ['and Delivered stays blank, since nothing sends it',
   "[].slice.call(document.querySelectorAll('#content .chip')).some(function(b){return b.innerText.indexOf('Delivered')>=0 && !/\\d/.test(b.innerText)})"],
]]);

run('home', CASES);
