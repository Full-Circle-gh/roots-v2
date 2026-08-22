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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..', 'public', 'm.html');

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try {
    const p = require('playwright').chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* not installed here */ }
  const guesses = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const g of guesses) { if (fs.existsSync(g)) return g; }
  const pw = '/opt/pw-browsers';
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw)) {
      const p = path.join(pw, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

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

// txt() is defined in the page harness below; it is the innerText of one node.
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
    ['and it says where the reply lands', `document.querySelector('.sheet').innerText.includes('mini-app inbox')`],
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
    DB.reviews[0].id=7; DB.reviews[0].stream='review';
    APP.cmd('push','inbox'); APP.cmd('openReply', revKey(DB.reviews[0]));`, [
    ['no thread was fetched',           `state_thread_null()`],
    ['the composer is there',           `!!document.getElementById('mReply')`],
    ['and it names the public surface', `document.querySelector('.sheet').innerText.includes('under the review')`],
  ]],
];

function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP — no Chromium found. Set CHROME_BIN to run this check.'); process.exit(0); }
  let src = fs.readFileSync(APP, 'utf8')
    .replace(/<script src="https:\/\/unpkg\.com[^>]*><\/script>/, '')
    .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, '');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm-inbox-'));
  let pass = 0; const failures = [];

  for (const [name, setup, checks] of CASES) {
    // The probe runs INSIDE the app page: `state` is a const, so a parent frame
    // cannot see it, and only in here does txt() read the node the user reads.
    const harness = `<script>addEventListener('load',function(){setTimeout(function(){
      var out=[];
      function txt(id){ var el=document.getElementById(id); return el?el.innerText:''; }
      function state_thread_null(){ return state.thread===null||state.thread===undefined; }
      try{ ${setup} }catch(e){ document.title='SETUP '+e.message; return; }
      var checks=${JSON.stringify(checks.map((c) => c[0]))};
      var fns=[${checks.map((c) => `function(){return (${c[1]})}`).join(',')}];
      for(var i=0;i<fns.length;i++){
        var ok=false, why='';
        try{ ok=!!fns[i](); }catch(e){ why=' ('+e.message+')'; }
        if(!ok) out.push(checks[i]+why);
      }
      document.title = out.length ? ('BAD '+out.join(' ¦ ')) : 'GOOD';
    },250)});</script>`;
    const file = path.join(dir, name.replace(/[^a-z0-9]/gi, '_') + '.html');
    fs.writeFileSync(file, src.replace('</body>', harness + '</body>'));
    let out = '';
    try {
      out = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
        '--window-size=500,940', '--virtual-time-budget=2500', '--dump-dom', 'file://' + file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
    } catch (e) { failures.push([name, 'chrome failed: ' + e.message]); continue; }
    const title = (out.match(/<title>([^<]*)<\/title>/) || [])[1] || 'no title';
    if (title === 'GOOD') { console.log(`  ✓ ${name} — ${checks.length} checks`); pass += checks.length; }
    else {
      const bad = title.replace(/^BAD /, '').split(' ¦ ');
      console.log(`  ✗ ${name}`);
      for (const b of bad) console.log(`      ${b}`);
      failures.push([name, bad.length]);
      pass += checks.length - (title.startsWith('BAD') ? bad.length : checks.length);
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\n${failures.length} of ${CASES.length} inbox cases failed.`);
    process.exit(1);
  }
  console.log(`\nok — ${pass} inbox assertions across ${CASES.length} cases.`);
}

main();
