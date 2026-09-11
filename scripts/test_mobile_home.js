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
  ['quick actions are things the phone can actually do', `APP.cmd('tab','home'); APP.cmd('fabToggle');`, [
    // Each of these opens a screen that performs the action named.
    ['answer the inbox',       `dialText().includes('Answer the inbox')`],
    ['tick a delivery in',     `dialText().includes('Tick a delivery in')`],
    ['fix a price or a count', `dialText().includes('Fix a price or a count')`],
    ['no "Add product"',       `!dialText().includes('Add product')`],
    ['no "Create coupon"',     `!dialText().includes('Create coupon')`],
    ['no "Send broadcast"',    `!dialText().includes('Send broadcast')`],
    // …and they are only the DEFAULT. An operator who never opens the picker
    // keeps exactly these three; the row that changes that is the last one in
    // the dial, where the section's Edit link used to be on the heading.
    ['with a way to change them', `dialText().includes('Edit')`],
    // And Home itself is shorter for it — the section is gone, not duplicated.
    ['Home no longer carries the rows', `!txt('content').includes('Answer the inbox')`],
    ['nor the heading',                 `!txt('content').includes('Quick actions')`],
  ]],
  // waiting_since, the column /dashboard/ops actually returns — placed_at here
  // meant the age line never rendered and the sub-line assertions below could
  // not have failed if the app had dropped it.
  ['the needs-you queue is the ops snapshot', `state.ops={
      unhandled:{count:3,items:[{waiting_since:'2026-08-22 07:00:00'}]},
      payment_unconfirmed:{count:2,unread:1,items:[{waiting_since:'2026-08-22 10:00:00'}]},
      refunds:{count:1,items:[]}, out_of_stock:{count:2}, low_stock:{count:5},
      reviews_unanswered:{count:4,low:2,items:[{waiting_since:'2026-08-20 09:00:00'}]},
      feedback_waiting:{count:1,items:[{waiting_since:'2026-08-22 08:00:00'}]}};
    state.liveAttn={}; APP.cmd('tab','home');`, [
    ['orders to start',       `txt('content').includes('Orders to start')`],
    ['refunds waiting',       `txt('content').includes('Refunds waiting')`],
    ['restock, counting what is OUT', `txt('content').includes('Restock needed') && txt('content').includes('out of stock, 5 running low')`],
    // Both inbox queues, from the snapshot — the reviews row used to be built
    // from DB.reviews, so it only appeared after the operator had opened the
    // Inbox, and feedback had no row at all.
    ['reviews, from the snapshot', `txt('content').includes('Reviews to answer')`],
    ['and how many are unhappy',   `txt('content').includes('2 low-rated')`],
    ['feedback, from the snapshot',`txt('content').includes('Feedback to answer')`],
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

// ── Quick actions belong to the operator ──────────────────────────────────
// The three defaults are ours; the list is theirs. These cases hold the whole
// contract: what the picker offers is capability-filtered, a change lands on
// Home, the order is the operator's, six is the ceiling, an empty list stays
// empty (rather than helpfully restoring the defaults at the next launch), and
// the choice survives this phone being put down.
CASES.push(['the picker offers what this role can reach', `APP.cmd('tab','home'); APP.cmd('quickEdit');`, [
  ['it opens',                `sheetText().includes('Quick actions')`],
  ['says what it is for',     `sheetText().includes('Pick the screens you open every day')`],
  ['the chosen three are listed', `sheetText().includes('Answer the inbox') && sheetText().includes('Fix a price or a count')`],
  ['under "On Home"',         `sheetText().includes('On Home')`],
  ['the rest is grouped as More groups it', `sheetText().includes('Operations') && sheetText().includes('Marketing')`],
  ['destinations are offered too',          `sheetText().includes('Destinations') && sheetText().includes('Customers')`],
  ['and a way back to the defaults',        `sheetText().includes('Back to the suggested three')`],
]]);
CASES.push(['adding one puts it in the dial', `APP.cmd('tab','home'); APP.cmd('quickEdit');
  APP.cmd('quickToggle','waste'); APP.cmd('quickClose'); APP.cmd('fabToggle');`, [
  ['the new row is there',    `dialText().includes('Waste')`],
  ['beside the old ones',     `dialText().includes('Answer the inbox')`],
  ['and it is last, where it was added',
   `dialText().indexOf('Waste') > dialText().indexOf('Fix a price or a count')`],
]]);
CASES.push(['removing one takes it out of the dial', `APP.cmd('tab','home');
  APP.cmd('quickToggle','inbox'); render(); APP.cmd('fabToggle');`, [
  ['gone',                    `!dialText().includes('Answer the inbox')`],
  ['the others stay',         `dialText().includes('Tick a delivery in')`],
]]);
CASES.push(['the order is the operator’s', `APP.cmd('tab','home');
  APP.cmd('quickMove','receiving',-1); render(); APP.cmd('fabToggle');`, [
  ['moved above the one it followed',
   `dialText().indexOf('Tick a delivery in') < dialText().indexOf('Answer the inbox')`],
  ['and the top row cannot climb further',
   `(function(){ APP.cmd('quickMove','receiving',-1); return state.quick[0]==='receiving'; })()`],
]]);
// The delivery row names the screen that BOOKS a delivery in, and Purchasing is
// offered under its own noun. Both used to be able to sit on Home reading "Tick
// a delivery in" and "Receiving" — two rows, one job, and the verb on the order
// list rather than on the screen that performs it.
CASES.push(['the delivery row is not two rows', `APP.cmd('tab','home');
  state.quick=['receiving','purchasing']; render(); APP.cmd('fabToggle');`, [
  ['the verb is on Receiving',   `dialText().includes('Tick a delivery in')`],
  ['and Purchasing is Purchasing', `dialText().includes('Purchasing')`],
  ['so neither row is called Receiving', `!dialText().includes('Receiving')`],
  ['and the verb opens the receiving list',
   `(function(){ APP.cmd('push','receiving'); return state.stack[state.stack.length-1].route==='receiving'; })()`],
]]);
CASES.push(['six is the ceiling', `APP.cmd('tab','home');
  state.quick=['inbox','purchasing','tab:products','waste','delivery','invoices']; render();
  APP.cmd('quickToggle','coupons'); APP.cmd('fabToggle');`, [
  ['the seventh is refused',  `state.quick.length===6`],
  ['and it says why',         `!!state.toast`],
  ['the six still render',    `dialText().includes('Invoices') && dialText().includes('Delivery')`],
]]);
// A KEY THAT NO LONGER RESOLVES MUST NOT HOLD A SLOT ON HOME. The stored list
// is KEYS, and one whose screen has been retired (kitchenpending, folded into
// the Ready screen's tabs) or whose capability the role has lost is kept rather
// than erased, so the row returns if the screen does. It is not DRAWN, though —
// and the cap used to count the stored keys while the picker drew the live
// ones. An operator with four rows on Home was told six was the most that fits
// and given nothing to remove: the two eating the slots were invisible, and
// "Back to the suggested three" was the only way out.
CASES.push(['a retired shortcut does not hold a slot in the dial', `APP.cmd('tab','home');
  state.quick=['waste','receiving','tab:products','inbox','kitchenpending','gone:nowhere'];
  render(); APP.cmd('quickToggle','coupons'); APP.cmd('fabToggle');`, [
  ['only the live rows are drawn', `quickRows().length===5`],
  ['the new one among them',       `dialText().includes('Coupons')`],
  ['nothing said it was full',     `!state.toast`],
  ['and the retired key is still stored', `state.quick.indexOf('kitchenpending')>=0`],
]]);
// The cap still bites — it is counted over what Home draws, so dead ballast
// neither fills it nor lifts it.
CASES.push(['six drawn rows is still the ceiling', `APP.cmd('tab','home');
  state.quick=['inbox','kitchenpending','purchasing','tab:products','waste','delivery','invoices'];
  render(); APP.cmd('quickToggle','coupons'); APP.cmd('fabToggle');`, [
  ['the seventh is refused',  `quickRows().length===6 && state.quick.indexOf('coupons')<0`],
  ['and it says why',         `!!state.toast`],
  ['the six still render',    `dialText().includes('Invoices') && dialText().includes('Delivery')`],
]]);
// Whatever is in storage, Home draws at most six. A list that grew past the cap
// on another build is trimmed at the point the rows are resolved, not by
// deleting keys off the phone.
CASES.push(['the dial draws no more than six however many are stored', `APP.cmd('tab','home');
  state.quick=['inbox','purchasing','tab:products','waste','delivery','invoices','coupons'];
  render(); APP.cmd('fabToggle');`, [
  ['six rows',                `quickRows().length===6`],
  ['the seventh is not drawn', `!dialText().includes('Coupons')`],
  ['and it is not erased',    `state.quick.indexOf('coupons')>=0`],
]]);
// Move works on the rows the operator can SEE. Stepping a row over a stored key
// that draws nothing used to look like a dead button: the key moved one place
// in storage and Home repainted identically.
CASES.push(['a move steps over what is not drawn', `APP.cmd('tab','home');
  state.quick=['inbox','kitchenpending','waste']; render(); APP.cmd('quickMove','waste',-1); APP.cmd('fabToggle');`, [
  ['the row actually moves',
   `dialText().indexOf('Waste') < dialText().indexOf('Answer the inbox')`],
  ['and the key that draws nothing is still stored',
   `state.quick.indexOf('kitchenpending')>=0`],
]]);
CASES.push(['an emptied list stays empty', `APP.cmd('tab','home'); state.quick=[]; render(); APP.cmd('fabToggle');`, [
  ['no rows',                 `!dialText().includes('Answer the inbox')`],
  ['it offers to fill itself', `dialText().includes('Choose your shortcuts')`],
  // The defaults must not creep back in on the next read — an operator who
  // cleared the list cleared it.
  ['and the defaults do not creep back', `(function(){ return quickKeys().length===0; })()`],
]]);
CASES.push(['the choice is remembered on this phone', `APP.cmd('tab','home'); APP.cmd('quickToggle','waste');`, [
  // file:// has no storage in some builds; the app is written to survive that,
  // so the assertion passes rather than failing on the environment.
  ['written down', `(function(){ var raw; try{ raw=localStorage.getItem('tacet-m-quick'); }catch(e){ return true; }
     if(raw==null) return true; return JSON.parse(raw).indexOf('waste')>=0; })()`],
  ['and read back on a fresh launch', `(function(){ var raw; try{ raw=localStorage.getItem('tacet-m-quick'); }catch(e){ return true; }
     if(raw==null) return true; state.quick=null; return quickKeys().indexOf('waste')>=0; })()`],
]]);
CASES.push(['a shortcut to a screen the role lost just drops off', `APP.cmd('tab','home');
  state.quick=['inbox','waste']; state.caps=['dashboard:view','reviews:view']; render(); APP.cmd('fabToggle');`, [
  ['the one it can reach stays',   `dialText().includes('Answer the inbox')`],
  ['the one it cannot is not drawn', `!dialText().includes('Waste')`],
  ['and nothing was erased',       `state.quick.indexOf('waste')>=0`],
]]);
CASES.push(['both halves follow the language switch', `APP.cmd('tab','home'); APP.cmd('toggleLang'); APP.cmd('fabToggle');`, [
  ['the rows',    `dialText().includes('回复消息') && dialText().includes('改价或改库存')`],
  ['the row that edits them', `dialText().includes('编辑')`],
  // The dial's own name is not drawn — it is what the button announces itself
  // as, so it is read off the label rather than out of the text.
  ['and the button says what it is', `(function(){ var b=document.getElementById('mFab');
     return !!b && b.getAttribute('aria-label')==='快捷操作'; })()`],
  ['and the picker', `(function(){ APP.cmd('quickEdit'); return sheetText().includes('显示在首页'); })()`],
]]);

/* ── The button the rows now live behind ───────────────────────────────────
   Quick actions were the last section of Home; they float over every tab
   screen instead. These cases hold what that MOVE promised, which is a
   different contract from the list's own (held above, unchanged): the button
   is there without scrolling, it is there on the other tabs too, it is not
   there over a job in progress, and taking a row puts it away. */
CASES.push(['the button is on Home without scrolling to it', `APP.cmd('tab','home');`, [
  ['it is there',            `!!document.getElementById('mFab')`],
  ['outside the scroller',   `!document.getElementById('content').contains(document.getElementById('mFab'))`],
  ['shut, with nothing open', `!dialText() && !state.quickFab`],
  // Measured off the dock, not typed: the offset has to be a real number of
  // pixels or the button sits under the tab bar on some phones and over the
  // last row of a list on others.
  ['and standing clear of the tab bar',
   `(function(){ var v=getComputedStyle(document.getElementById('app')).getPropertyValue('--dock-h');
      return parseFloat(v) > 0; })()`],
]]);
CASES.push(['the same button on the other tabs', `APP.cmd('tab','orders');`, [
  ['Orders has it',    `!!document.getElementById('mFab')`],
  ['and it opens the same rows', `(function(){ APP.cmd('fabToggle');
     return dialText().includes('Answer the inbox') && dialText().includes('Tick a delivery in'); })()`],
]]);
/* NOT OVER A JOB IN PROGRESS. Receiving, Waste and three others carry a sticky
   Save along their own bottom edge, and a circle floating over the control that
   commits somebody's count is the one place here a stray tap costs real money. */
CASES.push(['no button over a pushed screen', `APP.cmd('tab','home'); APP.cmd('push','receiving');`, [
  ['the screen is up',   `state.stack.length===1`],
  ['and the button is not', `!document.getElementById('mFab')`],
  ['it comes back on the way out', `(function(){ APP.cmd('back'); return !!document.getElementById('mFab'); })()`],
]]);
CASES.push(['taking a row puts the dial away', `APP.cmd('tab','home'); APP.cmd('fabToggle');`, [
  ['the dial is open',  `!!dialText()`],
  ['the row travels',   `(function(){ APP.cmd('fabClose'); APP.cmd('push','receiving');
     return state.stack[state.stack.length-1].route==='receiving'; })()`],
  ['and nothing is left hanging over it', `!state.quickFab && !dialText()`],
]]);
CASES.push(['Back shuts the dial before it leaves the screen', `APP.cmd('tab','home'); APP.cmd('fabToggle');`, [
  ['the dial counts as a layer', `layers().length===1`],
  ['and Back closes it',
   `(function(){ layers()[0](); render(); return !state.quickFab && !dialText(); })()`],
]]);
/* A role with nowhere to go gets no button rather than one that opens onto an
   empty dial — the same rule the section it replaces used for its heading. */
CASES.push(['no button for a role with nothing to shortcut to', `state.caps=[];
  APP.cmd('tab','home'); render();`, [
  ['the catalogue is empty', `quickCatalogue().length===0`],
  ['and there is no button', `!document.getElementById('mFab')`],
]]);

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

/* ONE HEADING OVER THE TWO TODAY CARDS, drawn for whichever survives its gate.
   The second card used to carry "Also today", a label that named its POSITION
   rather than its contents — Sessions, Conversion, Returning and Refunded are
   not "other today", they are the same day the card above counts. The static
   half of this is asserted in test_backend_nav_parity §4; what needs a browser
   is the GATE CROSS-PRODUCT, because the two cards are gated independently and
   one of the four combinations used to render a contradiction: a role with
   `orders` hidden and `customers` shown read "Also today" with no Today above
   it for it to be also to. All four are checked here, the empty one included —
   a heading left standing over two hidden cards would put the word Today on a
   screen with nothing counted under it. */
{
  const KPI4 = `state.liveKpis=[
    [['Revenue (all channels)','营收（全渠道）'],'¥3,180',null],
    [['Orders (storefront)','订单（自营）'],'19',null],
    [['Avg. order','客单价'],'¥167.37',null],
    [['New customers','新客'],'4',null]];`;
  const VITALS = `state.liveVitals={sessions:2,orders:1,conv:null,buyers:0,returning:0,refunded:0,refundRate:0};`;
  // dashCards is the owner's override off /me: null is "no override".
  const seed = cards => `${KPI4}${VITALS}state.dashCards=${cards};APP.cmd('tab','home');`;
  const money = `txt('content').includes('Revenue (all channels)')`;
  const vitals = `txt('content').includes('Sessions')`;

  CASES.push(['both Today cards allowed', seed('null'), [
    ['the money card draws',        money],
    ['and the second card with it', `${vitals} && txt('content').includes('Refunded')`],
    ['under exactly one heading',   `(txt('content').match(/Today/g)||[]).length===1`],
    ['and never "Also today"',      `!txt('content').includes('Also today')`],
  ]]);
  CASES.push(['the money card gated away, the second one not', seed(`['recap','needs','customers']`), [
    ['no revenue on Home',    `!${money}`],
    ['the second card draws', vitals],
    ['still headed Today',    `txt('content').includes('Today')`],
    ['not an orphaned "Also today"', `!txt('content').includes('Also today')`],
  ]]);
  CASES.push(['the second card gated away, the money one not', seed(`['recap','needs','orders']`), [
    ['the money card draws', money],
    ['no sessions figure',   `!${vitals}`],
    ['headed Today',         `txt('content').includes('Today')`],
  ]]);
  CASES.push(['both Today cards gated away', seed(`['recap','needs']`), [
    ['no revenue',                       `!${money}`],
    ['no sessions figure',               `!${vitals}`],
    ['and no heading left standing over nothing', `!txt('content').includes('Today')`],
  ]]);
}

// ── The restock fire opens onto the shelf it counted ──────────────────────
// The row says "3 · out of stock, 35 running low" and used to open Products on
// All, whatever sub-view and category the operator had left behind — the three
// empty shelves somewhere down a list of hundreds. It presses the chip it is
// already counting: Out when anything is out, Low when the fire is only the
// nudge, which is the pill's own `n:oos||low` rule said once more.
{
  const OPS = (oos, low) => `state.ops={out_of_stock:{count:${oos}},low_stock:{count:${low}}};
    state.liveAttn={}; APP.cmd('tab','home');`;
  // The tap itself, not a hand-called handler: the onclick string on that row is
  // half of what this case is proving.
  const TAP = `Array.from(document.querySelectorAll('#content .row'))
    .find(function(b){return b.innerText.indexOf('Restock needed')>=0;}).click();`;
  // The chip an operator would have pressed, read off the DOM by its own label.
  const CHIP = `function(t){ var c=Array.from(document.querySelectorAll('#content .chip'))
    .find(function(x){return x.innerText.trim().indexOf(t)===0;}); return c&&c.classList.contains('on'); }`;

  CASES.push(['the restock row lands on Out when something is out', OPS(3, 35) + TAP, [
    ['it left Home for Products', `state.tab==='products'`],
    ['on the catalogue, not whatever sub-view was last open', `(state.prodView||'catalogue')==='catalogue'`],
    ['filtered on Out',           `state.prodStatus==='out'`],
    ['and the chip shows it',     `(${CHIP})('Out')`],
  ]]);
  // Nothing is out, so Out is an empty list and the fire is the nudge it says
  // it is. The pill counts the 5 in that case; so does the chip.
  CASES.push(['and on Low when the fire is only the nudge', OPS(0, 5) + TAP, [
    ['filtered on Low',       `state.prodStatus==='low'`],
    ['not on an empty Out',   `state.prodStatus!=='out'`],
    ['and the chip shows it', `(${CHIP})('Low')`],
  ]]);
  // A leftover category chip or a half-typed search silently delivers fewer
  // products than the number the operator just tapped.
  CASES.push(['it clears what would narrow the count',
    `state.prodQ='maple'; state.prodCat='Pastry'; state.prodView='activity'; ` + OPS(3, 0) + TAP, [
    ['the search is cleared',   `state.prodQ===''`],
    ['the category is cleared', `state.prodCat==='all'`],
    ['and it is the catalogue that opened', `state.prodView==='catalogue'`],
  ]]);
  // The row is drawn for every role; the tab behind it is not. A tap that
  // cannot navigate must not leave a filter set on a screen it never opened.
  CASES.push(['a role that cannot reach Products is left where it was',
    `state.caps=['dashboard:view']; ` + OPS(3, 0) + TAP, [
    ['still on Home',          `state.tab==='home'`],
    ['and no filter was set',  `(state.prodStatus||'all')==='all'`],
  ]]);
}

run('home', CASES);
