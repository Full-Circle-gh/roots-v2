#!/usr/bin/env node
/**
 * The Sales board, asserted against meituan-admin.js `GET /channel-status` and
 * retail.js `GET /sales/summary`.
 *
 *   node scripts/test_mobile_sales.js
 *
 * This screen had no test and no screenshot, and for a reason worth recording:
 * SUBS.sales is assigned to the SUBS object AFTER its literal — it moved there
 * when Customers and Products took the bottom nav — and both the sweep and the
 * camera discovered screens by matching keys INSIDE the literal. So Sales was
 * never rendered by the sweep, never measured by the geometry check, and never
 * photographed. The fake server's fixture for it was wrong in the way that only
 * shows up when you look: it sent `stores` where the route sends `cells`, so
 * every card would have read "No stores", and it listed three of the six
 * channels in GRID_CHANNELS.
 *
 * So the assertions here are mostly about the grid being the server's: every
 * channel it names, the open/closed state per store, and today's money said as
 * today's.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// Six channels: two fully open, one open at one store of two, one with no
// integration at all, one single-store, one shut everywhere. Between them they
// cover every pill this screen can draw.
const GRID = `state.chanTried=true; state.chan={channels:[
  {channel:'mini_app', integrated:true, cardOpen:true,
   cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:true},
          {storeCode:'panyu',nameEn:'Panyu',nameCn:'番禺店',open:true}]},
  {channel:'web', integrated:true, cardOpen:true,
   cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:true},
          {storeCode:'panyu',nameEn:'Panyu',nameCn:'番禺店',open:false}]},
  {channel:'meituan', integrated:true, cardOpen:true,
   cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:true},
          {storeCode:'panyu',nameEn:'Panyu',nameCn:'番禺店',open:true}]},
  {channel:'eleme', integrated:false, cardOpen:false, cells:[]},
  {channel:'gzgrocery', integrated:true, single:'tianhe', cardOpen:true,
   cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:true}]},
  {channel:'pos', integrated:true, cardOpen:false,
   cells:[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',open:false},
          {storeCode:'panyu',nameEn:'Panyu',nameCn:'番禺店',open:false}]}
]};
state.sales={wechat:{connected:true,revenue:2140.5,orders:12},
             web:{connected:true,revenue:612,orders:3},
             meituan:{connected:true,revenue:288,orders:4},
             gzgrocery:{connected:true,revenue:1180,orders:2},
             eleme:{connected:false,revenue:0,orders:0},
             pos:{connected:true,revenue:143,orders:6}};
state.salesSummary={revenue:4363.5,orders:27,aov:161.6,active:5,total:6};
APP.cmd('push','sales');`;

const CASES = [
  ['the board is the server\'s grid', GRID, [
    ['every channel it names is drawn', `['Mini app','Web store','Meituan','Eleme','gzgrocery','In store']
        .every(function(n){return txt('content').includes(n)})`],
    ['open everywhere reads Open',      `txt('content').includes('Open')`],
    ['partly open counts the stores',   `txt('content').includes('Open at 1 of 2')`],
    // Its own line, capitalised, and allowed to wrap — three facts never fit
    // on the money line, at any wording.
    ['and names the shut one',          `txt('content').includes('Closed at Panyu')`],
    ['shut everywhere reads Closed',    `txt('content').includes('Closed')`],
    // A channel with no integration has no open/closed state at all, and used
    // to be given one.
    ['no integration says so, not Closed', `txt('content').includes('Not connected')`],
    ['a mirror says it is read-only',   `txt('content').includes('View only')`],
    ['the head line names what is shut', `txt('content').includes('In store is closed everywhere')`],
    // §326.2 — the whole-channel flip came to the phone (§325 X12), so the
    // footer that sent it to the desktop is gone rather than left untrue.
    ['nothing sends closing to the desktop', `!txt('content').includes('everywhere is on desktop')`],
  ]],
  ['today\'s money is said as today\'s', GRID, [
    // The day's total is what this screen is opened for, and loadChannels used
    // to fetch it inside `summary` and throw it away.
    ['the total is in the header band', `txt('content').includes('¥4,364 today · 27 orders')`],
    ['and each channel carries its own', `txt('content').includes('12 today · ¥2,141')`],
    // The old line was a bare number with no window on it, which reads as
    // all-time takings — so every channel that sold anything says "today", and
    // there are five of them.
    ['every selling channel dates its figure',
     `(txt('content').match(/\\btoday\\b/g)||[]).length >= 6`],
  ]],
  // Ash's board: no shop shut, no channel shut everywhere, but channels closed
  // at ONE shop. The head line fell through to "Every channel is open" above
  // three cards saying "Closed at Yuexiu".
  ['closed at one shop is not "every channel is open"', GRID + `
    var pos=state.chan.channels.find(function(c){return c.channel==='pos'});
    pos.cardOpen=true; pos.cells.forEach(function(x){x.open=true});
    render();`, [
    ['web is still shut at Panyu',  `txt('content').includes('Closed at Panyu')`],
    ['the head line does not say all open', `!txt('content').includes('Every channel is open')`],
    ['it says some are closed',     `txt('content').includes('Some channels are closed')`],
  ]],
  ['everything open everywhere still says so', GRID + `
    state.chan.channels.forEach(function(c){c.cardOpen=true;(c.cells||[]).forEach(function(x){x.open=true})});
    render();`, [
    ['the head line says all open', `txt('content').includes('Every channel is open')`],
  ]],
  // The header is the server's seven buckets plus top-up cash; the board drew
  // six, so the cards fell short of the total with nothing saying why. Same
  // grid, plus one staff-keyed order and a top-up: the header moves by both,
  // and the board now shows where each one went.
  ['what no channel card carries is still on the board', GRID + `
    state.sales.direct={connected:true,intrinsic:true,revenue:150,orders:1};
    state.salesSummary={revenue:7513.5,orders:28,aov:161.3,active:5,total:6,topups_received:3000};
    render();`, [
    ['the header counts both',        `txt('content').includes('¥7,514 today · 28 orders')`],
    ['the staff-keyed order has a card', `txt('content').includes('Direct orders') && txt('content').includes('1 today · ¥150')`],
    ['and the top-up is named',       `txt('content').includes('Wallet top-ups (¥3,000) are in the total above')`],
  ]],
  ['nothing extra when there is nothing to explain', GRID, [
    ['no direct card at zero',  `!txt('content').includes('Direct orders')`],
    ['no top-up line at zero',  `!txt('content').includes('Wallet top-ups')`],
  ]],
  ['a shop with no channels',`state.chanTried=true; state.chan={channels:[]}; APP.cmd('push','sales');`, [
    ['says so',        `txt('content').includes('No channels yet')`],
    ['and invents none', `!txt('content').includes('Mini app')`],
  ]],
  ['before the grid lands', `APP.cmd('push','sales');`, [
    ['it says loading, not empty', `txt('content').includes('Loading') && !txt('content').includes('No channels yet')`],
  ]],
];

// ── The writes ─────────────────────────────────────────────────────────────
// Asserted on the REQUEST, never the toast. A write that reports success and
// sends nothing is the worst shape a bug in this app has taken twice: APP.cmd
// forwarding one argument to a two-argument handler, and a create sheet whose
// submit was a showToast. Both looked like success from the glass.
const STUB = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u), m:(o&&o.method)||'GET', body:(o&&o.body)||null});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true,data:{}})}}); };`;
const sent = (frag) => `window.__sent.some(function(r){return r.u.indexOf(${JSON.stringify(frag)})>=0})`;
const body = (frag) => `window.__sent.some(function(r){return (r.body||'').indexOf(${JSON.stringify(frag)})>=0})`;
// A WRITE, not any request. Opening the board now reads /channel-status on
// every entry, so "nothing was sent yet" has to mean nothing was WRITTEN.
const wrote = (frag) => `window.__sent.some(function(r){return r.m!=='GET'&&r.u.indexOf(${JSON.stringify(frag)})>=0})`;
const read = (frag) => `window.__sent.some(function(r){return r.m==='GET'&&r.u.indexOf(${JSON.stringify(frag)})>=0})`;

// The board is "today", so it is read on every entry and on every return to
// the app. It used to be read once per session: opened at 8am and left
// running, Ash's phone said "In store · 0 today" at 10am over six paid till
// and QR sales (2026-10-20). GRID marks the board as already loaded before it
// pushes, which is exactly the state that never refreshed.
CASES.push(['opening the board reads it again', STUB + GRID, [
  ['entering asks the server for the grid', read('/channel-status')],
  ['the figures already on screen stay up meanwhile', `txt('content').includes('6 today · ¥143')`],
]]);
CASES.push(['coming back to the app reads it again', STUB + GRID
  + `window.__sent=[]; document.dispatchEvent(new Event('visibilitychange'));`, [
  ['the board asks the server again', read('/channel-status')],
]]);
CASES.push(['coming back on another screen does not', STUB + GRID
  + `APP.cmd('back'); window.__sent=[]; document.dispatchEvent(new Event('visibilitychange'));`, [
  ['no sales read off the Sales board', `!${read('/channel-status')}`],
]]);

CASES.push(['closing one store asks first', STUB + GRID + `APP.cmd('openChannel','meituan'); APP.cmd('chanCell','meituan','panyu',0);`, [
  ['it names the channel and the store', `sheetText().includes('Close Meituan at Panyu?')`],
  // "Closed" reads as "cancelled" if you do not say otherwise, and the orders
  // already in the kitchen are the first thing anyone would worry about.
  ['it says what does NOT stop',         `sheetText().includes('Orders already placed are not affected')`],
  ['and nothing was sent yet',           `!${wrote('/channel-status')}`],
]]);

CASES.push(['confirming sends the cell write', STUB + GRID
  + `APP.cmd('openChannel','meituan'); APP.cmd('chanCell','meituan','panyu',0); APP.cmd('askRun');`, [
  ['to the per-store endpoint',   sent('/channel-status/cell')],
  ['never the whole-channel one', `!${sent('/channel-status/channel')}`],
  ['carrying the channel',        body('"channel":"meituan"')],
  ['carrying the store',          body('"storeCode":"panyu"')],
  ['and open:false, not undefined', body('"open":false')],
]]);

CASES.push(['opening one back up', STUB + GRID
  + `APP.cmd('openChannel','pos'); APP.cmd('chanCell','pos','tianhe',1); APP.cmd('askRun');`, [
  ['asks in the other direction', `${sent('/channel-status/cell')}`],
  ['with open:true',              body('"open":true')],
]]);

// §253 — a shut shop. Panyu is closed as a shop; the web row there used to open
// an explainer pointing at the shop switch, because the server refused the
// write. It now opens the shop with only that channel, so the row asks and
// then sends the one cell write like every other row.
const SHUT = GRID + `state.chan.channels[1].cells[1].shopOpen=false;
  state.chan.locations=[{storeCode:'tianhe',nameEn:'Tianhe',nameCn:'天河店',shopOpen:true},
    {storeCode:'panyu',nameEn:'Panyu',nameCn:'番禺店',shopOpen:false,reopenChannels:['mini_app','pos']}];`;
const tapRow = (store) => `[].slice.call(document.querySelectorAll('.sheet .list button'))
  .filter(function(b){return b.innerText.indexOf(${JSON.stringify(store)})>=0})[0].click();`;

CASES.push(['a row under a shut shop says so', STUB + SHUT + `APP.cmd('openChannel','web');`, [
  ['the row says the shop is closed', `sheetText().includes('Shop closed')`],
]]);

CASES.push(['a channel at a shut shop can be opened on its own', STUB + SHUT
  + `APP.cmd('openChannel','web');` + tapRow('Panyu'), [
  ['tapping it asks to open that channel there', `sheetText().includes('Open Web store at Panyu?')`],
  ['not the old "open the shop first" explainer', `!sheetText().includes('Open Panyu under Shops')`],
  ['and nothing was sent yet', `!${wrote('/channel-status')}`],
]]);

CASES.push(['confirming it sends the one cell write', STUB + SHUT
  + `APP.cmd('openChannel','web');` + tapRow('Panyu') + `APP.cmd('askRun');`, [
  ['to the per-store endpoint', sent('/channel-status/cell')],
  ['not the shop switch',       `!${sent('/channel-status/location')}`],
  ['for web at Panyu',          body('"channel":"web"') + ' && ' + body('"storeCode":"panyu"')],
  ['with open:true',            body('"open":true')],
]]);

CASES.push(['reopening a shop names what comes back', STUB + SHUT + `APP.cmd('shopOpen','panyu',1);`, [
  ['the confirm names the remembered channels', `sheetText().includes('Open Mini app, In store at Panyu?')`],
  ['not "every sales channel"', `!sheetText().includes('Every sales channel at this shop opens')`],
]]);

// §326.2 brought the whole-channel flip to the phone (§325 X12): one button
// under the rows, drawn only once the operator's keys are known to hold, and
// it asks before it sends — one tap must not stop orders arriving everywhere.
CASES.push(['no whole-channel control while the keys are unknown', GRID + `state.caps=null; APP.cmd('openChannel','meituan');`, [
  ['the sheet offers no Close channel',
   `![].slice.call(document.querySelectorAll('.sheet button')).some(function(b){return /Close channel/.test(b.innerText)})`],
  ['and no longer sends it to the desktop', `!sheetText().includes('everywhere at once is on desktop')`],
]]);
CASES.push(['closing a channel everywhere asks first', STUB + GRID + `state.caps=['dashboard:view']; APP.cmd('openChannel','meituan');
  [].slice.call(document.querySelectorAll('.sheet button')).filter(function(b){return /Close channel/.test(b.innerText)})[0].click();`, [
  ['the desktop\'s own question', `sheetText().includes('Close this channel at every store?')`],
  ['it says what does NOT stop',   `sheetText().includes('Orders already placed are not affected')`],
  ['and nothing was sent yet',     `!${wrote('/channel-status')}`],
]]);
CASES.push(['confirming sends the whole-channel write', STUB + GRID + `state.caps=['dashboard:view']; APP.cmd('openChannel','meituan');
  APP.cmd('chanAll','meituan',0); APP.cmd('askRun');`, [
  ['to the whole-channel endpoint', sent('/channel-status/channel')],
  ['not the per-store one',         `!${sent('/channel-status/cell')}`],
  ['carrying the channel',          body('"channel":"meituan"')],
  ['and open:false',                body('"open":false')],
]]);

run('sales', CASES);
