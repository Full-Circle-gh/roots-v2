#!/usr/bin/env node
/**
 * The phone's Inbox, asserted against what the desktop actually shows.
 *
 *   node scripts/test_mobile_inbox.js
 *
 * scripts/test_mobile_screens.js proves every screen paints. It cannot prove a
 * screen paints the RIGHT thing, and the Inbox is where that distinction bit:
 *
 *   • mapFeedback was deleted outright by an unrelated edit and nothing failed,
 *     because it is only reached from a live fetch inside a try/catch.
 *   • The feedback row led with the thread ROOT. On a thread the store started,
 *     the root is the operator's own opener — so the customer's answer appeared
 *     nowhere on the phone at all.
 *   • A thread with four turns showed the newest one and a clipped root. The
 *     middle of the conversation existed on the desktop and nowhere else.
 *
 * These are assertions about rendered text, not about the source, so they move
 * when the render moves. Each case seeds state, renders, and reads innerText
 * out of a named element — never document.body.innerHTML, which contains the
 * whole script and answers "yes" to every indexOf you can think of.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// A feedback thread the customer opened and has come back to, and a direct
// message the store started. Between them they cover every mark the row draws.
const ROWS = `[
  {id:11, customer_name:'Wu Yaqi', kind:'bug', needs_reply:1, replied:0, reply_count:2,
   message:'Checkout kept the pickup time from my last order.',
   last_body:'Still doing it on the newest build.', last_author:'customer',
   page_context:'checkout', app_version:'2.4.1',
   photos:['/api/retail/media/8','/api/retail/media/9'],
   created_at:'2026-08-19 10:02:00', last_at:'2026-08-22 09:10:00'},
  {id:12, customer_name:'Zhang Wei', kind:'message', needs_reply:0, replied:1, reply_count:1,
   message:'Sorry about the late delivery — here is 20 off.',
   last_body:'Thanks, got it.', last_author:'customer', last_author_name:null,
   created_at:'2026-08-20 12:00:00', last_at:'2026-08-21 08:00:00'}
]`;

const OPEN_FEEDBACK = `
  DB.feedback = ${ROWS}.map(mapFeedback);
  state.inboxSeg='feedback';
  APP.cmd('push','inbox');
`;

const THREAD = `{id:11, loading:false, err:null, page:'checkout', appVersion:'2.4.1',
  photos:['/api/retail/media/8'],
  msgs:[{id:0,author:'customer',body:'Checkout kept the pickup time from my last order.',created_at:'2026-08-19 10:02:00'},
        {id:1,author:'admin',author_name:'Mei',body:'Thanks — we are looking at it.',created_at:'2026-08-19 10:40:00'},
        {id:2,author:'customer',body:'Still doing it on the newest build.',created_at:'2026-08-22 09:10:00'}]}`;

// txt(id) and sheetText() come from scripts/lib/m-probe.js and read what is
// actually on the glass — never document.body, which contains the script.
const CASES = [
  ['feedback list', OPEN_FEEDBACK, [
    ['maps at all — the customer name is on the row',      `txt('content').includes('Wu Yaqi')`],
    ['leads with the newest turn, not the root',           `txt('content').includes('Still doing it on the newest build')`],
    ['keeps one line of the root for context',             `txt('content').includes('Checkout kept the pickup time')`],
    ['says who spoke last',                                `txt('content').includes('Customer')`],
    ['counts the turns',                                   `txt('content').includes('2 replies')`],
    ['needs_reply is a status, not silence',               `txt('content').includes('Needs reply')`],
    ['carries the page it was filed from, with a version', `txt('content').includes('checkout · v2.4.1')`],
    ['marks a thread the store started',                   `txt('content').includes('We messaged them')`],
    ['dates the thread it opened',                         `/opened /.test(txt('content'))`],
    ['shows the photos the customer attached',             `document.querySelectorAll("#content a[href^='/api/retail/media/']").length === 2`],
    ['a one-turn thread says reply, not replies',          `txt('content').includes('1 reply')`],
  ]],
  ['no root echo when there is nothing above it', `
    DB.feedback = [{id:13, customer_name:'Solo', kind:'bug', needs_reply:1, reply_count:0,
      message:'One and only message.', last_body:null, last_author:'customer',
      created_at:'2026-08-22 09:00:00', last_at:'2026-08-22 09:00:00'}].map(mapFeedback);
    state.inboxSeg='feedback'; APP.cmd('push','inbox');`, [
    ['the only message is the body',        `txt('content').includes('One and only message')`],
    ['and it is not also printed as opener', `txt('content').split('One and only message').length === 2`],
    ['no reply count on a thread with none', `!/\\breplies\\b/.test(txt('content'))`],
    ['no opened-on line either',             `!/opened /.test(txt('content'))`],
  ]],
  ['thread sheet', OPEN_FEEDBACK + `APP.cmd('openReply','fb:11'); state.thread=${THREAD}; render();`, [
    ['the first turn is on screen',   `txt('mThread').includes('Checkout kept the pickup time')`],
    ['THE MIDDLE TURN is on screen',  `txt('mThread').includes('Thanks — we are looking at it')`],
    ['the newest turn is on screen',  `txt('mThread').includes('Still doing it on the newest build')`],
    ['our turn is signed by operator', `txt('mThread').includes('Mei')`],
    ['their turns are signed Customer', `txt('mThread').includes('Customer')`],
    ['the photo is in the thread',    `document.querySelectorAll("#mThread a[href^='/api/retail/media/']").length === 1`],
    ['a composer is present',         `!!document.getElementById('mReply')`],
    ['and it says where the reply lands', `sheetText().includes('mini-app inbox')`],
  ]],
  ['thread still loading', OPEN_FEEDBACK + `APP.cmd('openReply','fb:11'); render();`, [
    ['says so rather than showing an empty thread', `txt('mThread').includes('Loading')`],
    ['and claims no turns it does not have',        `!txt('mThread').includes('Nothing in this thread yet')`],
  ]],
  ['thread failed to load', OPEN_FEEDBACK
    + `APP.cmd('openReply','fb:11'); state.thread={id:11,loading:false,msgs:null,err:'Could not load the conversation.'}; render();`, [
    ['says the conversation could not load', `txt('mThread').includes('Could not load the conversation')`],
    ['does not offer an empty thread',       `!txt('mThread').includes('Nothing in this thread yet')`],
  ]],
  ['a review is still a review, not a thread', `
    DB.reviews=[{cust:['Chen Meiling','陈美玲'],rating:'5.0',status:['New','新'],kind:'success',
      text:['Fast delivery.','配送很快。'],time:['2h ago','2 小时前']}];
    DB.reviews[0].id=7; DB.reviews[0].stream='review';
    APP.cmd('push','inbox'); APP.cmd('openReply', revKey(DB.reviews[0]));`, [
    ['no thread was fetched',           `state.thread===null||state.thread===undefined`],
    ['the composer is there',           `!!document.getElementById('mReply')`],
    ['and it names the public surface', `sheetText().includes('under the review')`],
  ]],
];

CASES.push(['a shop with no reviews', `DB.reviews=[]; state.revLoaded=true; APP.cmd('push','inbox');`, [
  // The mock's three reviews used to survive an empty server answer, because
  // the loader only assigned `if (list.length)`. revLoaded is what separates
  // "the server said none" from "the server has not answered".
  ['says there are none',  `txt('content').includes('No reviews yet')`],
  ['and invents none',     `!txt('content').includes('Chen Meiling') && !txt('content').includes('carrots were super fresh')`],
]]);

run('inbox', CASES);
