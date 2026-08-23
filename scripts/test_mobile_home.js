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

// [labelPair, value, deltaPair] — the label and the comparison are stored as
// bilingual PAIRS and resolved at render, because this array is built once at
// boot and used to freeze both in whatever language the app started in. A
// Chinese operator's Today card read "Revenue (all channels)".
const KPIS = `state.liveKpis=[
  [['Revenue (all channels)','营收（全渠道）'],'¥3,180',['+12% vs a typical day','较平常日 +12%']],
  [['Orders (storefront)','订单（自营）'],'19',['+3 vs a typical day','较平常日 +3']],
  [['Avg. order','客单价'],'¥167.37',null],
  [['New customers','新客'],'4',['−1 vs a typical day','较平常日 −1']]];`;

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
    // Both halves are stored, so the card follows the language switch. It used
    // to be built with T() already applied and stayed English forever.
    ['in Chinese too',     `(function(){ APP.cmd('toggleLang'); var zh=txt('content'); APP.cmd('toggleLang');
       return zh.indexOf('营收（全渠道）')>=0 && zh.indexOf('较平常日 +12%')>=0; })()`],
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
  // waiting_since, the column /dashboard/ops actually returns — placed_at here
  // meant the age line never rendered and the sub-line assertions below could
  // not have failed if the app had dropped it.
  ['the needs-you queue is the ops snapshot', `state.ops={
      unhandled:{count:3,items:[{waiting_since:'2026-08-22 07:00:00'}]},
      payment_unconfirmed:{count:2,unread:1,items:[{waiting_since:'2026-08-22 10:00:00'}]},
      refunds:{count:1,items:[]}, out_of_stock:{count:2}, low_stock:{count:5}};
    state.liveAttn={reviews:2}; APP.cmd('tab','home');`, [
    ['orders to start',       `txt('content').includes('Orders to start')`],
    ['refunds waiting',       `txt('content').includes('Refunds waiting')`],
    ['restock, counting what is OUT', `txt('content').includes('Restock needed') && txt('content').includes('out of stock, 5 running low')`],
    ['reviews, which the ops snapshot does not carry', `txt('content').includes('Reviews to reply')`],
    ['a queue with a clock is aged',   `/oldest \\d+[mhd]/.test(txt('content'))`],
    // The unreadable-proofs fire passes a SENTENCE as its sub-line, and the row
    // used to glue "oldest" onto the front of it: "oldest 1 couldn't be read".
    ['a queue with a sentence is not', `txt('content').includes("1 couldn't be read") && !txt('content').includes("oldest 1 couldn't")`],
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

// ── "Nothing yet" vs "not asked yet" ──────────────────────────────────────
// The sample rows are gone from DB entirely, which closed the whole class of
// mock-outlives-fetch bugs — and opened a smaller one in the other direction:
// with an empty store and no loaded flag, every one of these screens said a
// confident "none" for the length of a fetch. Each has a flag now.
const listCases = [
  ['coupons',    "coupons",    'vchLoaded',   'No coupons'],
  ['flash sales',"flash",      'flashLoaded', 'No flash sales'],
  ['broadcasts', "broadcasts", 'bcLoaded',    'No broadcasts'],
];
for (const [label, screen, flag, emptyText] of listCases) {
  CASES.push([label + ' before the fetch lands', `state.${flag}=false; DB.${screen === 'coupons' ? 'coupons' : screen}=[]; APP.cmd('push','${screen}');`, [
    ['says it is loading',       `txt('content').includes('Loading')`],
    ['not that there are none',  `!txt('content').includes(${JSON.stringify(emptyText)})`],
  ]]);
}
CASES.push(['an inbox before the fetch lands', `state.revLoaded=false; DB.reviews=[]; APP.cmd('push','inbox');`, [
  ['says it is loading',      `txt('content').includes('Loading')`],
  ['not "No reviews yet"',    `!txt('content').includes('No reviews yet')`],
]]);
CASES.push(['an inbox that really is empty', `state.revLoaded=true; DB.reviews=[]; APP.cmd('push','inbox');`, [
  ['says there are none',  `txt('content').includes('No reviews yet')`],
  ['and stops loading',    `!txt('content').includes('Loading')`],
]]);

// The desktop prints "0%" for the returning rate on purpose, and says why in a
// comment: an absent figure makes the reader guess between "none", "not
// loaded" and "broken", and only one of those is true. The phone went null on
// a shop with no buyers, which dropped the whole clause out of the line.
CASES.push(['a shop where nobody has come back', `state.custMeta={all:12,buyers:5,returnRate:0,never:7};
  state.customers=[]; state.custLoaded=true; APP.cmd('tab','customers');`, [
  ['0% is printed',       `txt('content').includes('0% returning')`],
  ['beside the buyers',   `txt('content').includes('5 buyers')`],
  ['and the never-ordered', `txt('content').includes('7 never ordered')`],
]]);

run('home', CASES);
