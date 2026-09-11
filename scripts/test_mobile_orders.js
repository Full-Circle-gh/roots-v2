#!/usr/bin/env node
/**
 * The order writes — what the phone actually sends when it moves an order.
 *
 *   node scripts/test_mobile_orders.js
 *
 * Every other probe in this directory reads the screen. This one reads the
 * request, because of what APP.cmd taught: a write can report success and send
 * nothing. The dispatcher forwarded one argument to a two-argument handler, the
 * body lost its only field, JSON.stringify dropped the key, the server saw an
 * empty patch and answered 200, and the phone showed a green toast. Nothing on
 * the glass was wrong. The bug lived entirely in the request.
 *
 * These are the writes on this app with the worst consequences if a field goes
 * missing quietly: the tender an off-app payment is booked under, the way a
 * refund actually leaves, and the state machine's next step. All three are
 * asserted against a stubbed fetch.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

const STUB = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u), m:(o&&o.method)||'GET', body:(o&&o.body)||null});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true,data:{}})}}); };`;

// The app ships no sample data any more, so the row a write test needs is the
// test's own.
const ONE_ORDER = `DB.orders=[{id:'RT-…047', ch:'miniapp', cust:['Chen Meiling','陈美玲'], total:'¥312',
    placed:'2:22 PM', status:['Paid','已付款'], kind:'paid', ship:['Guangzhou · Tianhe','广州 · 天河区'],
    phone:'138****2841', addr:['Tianhe, Guangzhou','广州市天河区'], pay:['WeChat Pay','微信支付'],
    txn:'42000••••8831', fulfil:['Tianhe store','天河店'], route:['Nearest store','最近门店'],
    trk:null, items:[[1,'Organic carrots 500g','¥18']], breakdown:[['Subtotal','¥312']]}]; `;
const openOrder = (raw) => ONE_ORDER + `DB.orders[0]._id=77; DB.orders[0].raw='${raw}';
  state.liveOrders=DB.orders; APP.cmd('tab','orders'); APP.cmd('openOrder',DB.orders[0].id);`;

const sent = (frag) => `window.__sent.some(function(r){return r.u.indexOf(${JSON.stringify(frag)})>=0})`;
const body = (frag) => `window.__sent.some(function(r){return (r.body||'').indexOf(${JSON.stringify(frag)})>=0})`;

const CASES = [
  ['marking paid books the tender it was told',
   openOrder('pending_payment') + STUB + `APP.cmd('markPaid'); APP.cmd('askRun','bank_transfer');`, [
    ['it PATCHes the order\'s status', `${sent('/orders/77/status')} && window.__sent.some(function(r){return r.m==='PATCH'})`],
    ['to paid',                        `${body('"status":"paid"')}`],
    // "Recording the tender keeps the day's takings split correctly" is what
    // the sheet promises. If pay_method went missing the books would show an
    // unknown tender and the sheet would still say Marked paid.
    ['CARRYING THE TENDER PICKED',     `${body('"pay_method":"bank_transfer"')}`],
    ['and not some other one',         `!${body('"pay_method":"cash"')}`],
  ]],
  ['a different tender is a different tender',
   openOrder('pending_payment') + STUB + `APP.cmd('markPaid'); APP.cmd('askRun','cash');`, [
    ['cash goes as cash', `${body('"pay_method":"cash"')}`],
  ]],
  ['cancelling the tender sheet sends nothing',
   openOrder('pending_payment') + STUB + `APP.cmd('markPaid'); APP.cmd('closeAsk');`, [
    ['no request at all', `window.__sent.length === 0`],
  ]],
  ['paying a refund out records how it went',
   ONE_ORDER + `DB.orders[0]._id=77; DB.orders[0].raw='paid'; DB.orders[0].refundStatus='approved';
    state.liveOrders=DB.orders; APP.cmd('openOrder',DB.orders[0].id);` + STUB
    + `APP.cmd('payRefund'); APP.cmd('askRun','wallet');`, [
    ['it posts the payout', `${sent('/orders/77/refund/payout')}`],
    ['with the method',     `${body('"method":"wallet"')}`],
  ]],
  // advance takes ONE argument, which the old single-argument dispatcher did
  // forward correctly — only the two-argument handlers were broken. This is
  // here so the state machine's own write is pinned to the wire as well.
  ['advancing an order sends the next status, not an empty patch',
   openOrder('paid') + STUB + `APP.cmd('advance','preparing');`, [
    ['it PATCHes status',     `${sent('/orders/77/status')}`],
    ['to preparing',          `${body('"status":"preparing"')}`],
    ['never an empty body',   `!window.__sent.some(function(r){return r.u.indexOf('/status')>=0 && r.body==='{}'})`],
  ]],
];

// A promised ship DATE has no clock in it. It was going through fmtDay, which
// answers a timestamp due today with the time of day — so an order to ship
// today read "12:00 AM", a midnight nobody set, on the row a shop scans to see
// what it owes today.
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const plus = (n) => new Date(Date.now() + 8 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);

CASES.push(['a ship date due today says Today', ONE_ORDER + `
  DB.orders=[]; state.ordersView=[mapOrderRow({id:1,order_no:'RT-1',status:'paid',channel:'wechat',
    recipient_name:'A', total:10, placed_at:'${today} 09:00:00', fulfillment_type:'delivery',
    promised_ship_date:'${today}'})];
  state.liveOrders=state.ordersView; state.ordersLoading=false; APP.cmd('tab','orders');`, [
  ['it says Today',       `txt('content').includes('Today')`],
  ['NOT a midnight time', `!txt('content').includes('12:00 AM') && !txt('content').includes('00:00')`],
]]);

CASES.push(['tomorrow says Tomorrow', ONE_ORDER + `
  DB.orders=[]; state.ordersView=[mapOrderRow({id:1,order_no:'RT-1',status:'paid',channel:'wechat',
    recipient_name:'A', total:10, placed_at:'${today} 09:00:00', fulfillment_type:'delivery',
    promised_ship_date:'${plus(1)}'})];
  state.liveOrders=state.ordersView; state.ordersLoading=false; APP.cmd('tab','orders');`, [
  ['it says Tomorrow', `txt('content').includes('Tomorrow')`],
]]);

CASES.push(['a date further out still reads as a date', ONE_ORDER + `
  DB.orders=[]; state.ordersView=[mapOrderRow({id:1,order_no:'RT-1',status:'paid',channel:'wechat',
    recipient_name:'A', total:10, placed_at:'${today} 09:00:00', fulfillment_type:'delivery',
    promised_ship_date:'${plus(9)}'})];
  state.liveOrders=state.ordersView; state.ordersLoading=false; APP.cmd('tab','orders');`, [
  // Scoped: the row also carries the order's PLACED time, which is a real
  // clock and must stay.
  ['a month and a day',   `/[A-Z][a-z]{2} \\d{1,2}/.test(txt('content'))`],
  ['no midnight in it',   `!txt('content').includes('12:00 AM')`],
  ['and not Today either', `!txt('content').includes('Today')`],
]]);

/* ══════════════════════════════════════════════════════════════════════════
   §97 — THE REFUND AND CANCEL HALF OF THE STATUS MACHINE

   Until this change the phone could not refund an order and could not cancel
   one, from any status. Approve / Reject / Pay moved a refund the CUSTOMER had
   opened, which is a different act, and it was all this surface had.

   The first two cases below are not written by hand. They READ the desktop's
   NEXT_STATUS and the server's STATUS_TRANSITIONS out of their own files and
   hold the phone's two tables to them — so a transition added to either one
   goes red HERE rather than being noticed a month later as "the phone can't do
   that". A table copied by hand into a test only ever proves it was copied.
   ══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// The desktop's NEXT_STATUS: `key: [['status', 'label'], …]`.
function desktopMoves() {
  const src = readSrc('public/retail-admin/04-orders.js');
  const block = /const NEXT_STATUS = \{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error('NEXT_STATUS not found in 04-orders.js — re-find it by name');
  const out = {};
  for (const m of block[1].matchAll(/^\s{2}(\w+):\s*\[(.*)\],\s*$/gm)) {
    out[m[1]] = [...m[2].matchAll(/\['(\w+)'/g)].map((x) => x[1]);
  }
  if (!Object.keys(out).length) throw new Error('NEXT_STATUS parsed empty');
  return out;
}

// The server's STATUS_TRANSITIONS is keyed the other way round — each target
// names the statuses it may be reached FROM — so invert it.
function serverMoves() {
  const src = readSrc('routes/retail.js');
  const block = /const STATUS_TRANSITIONS = \{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error('STATUS_TRANSITIONS not found in routes/retail.js — re-find it by name');
  const out = {};
  for (const m of block[1].matchAll(/(\w+):\s*\{[^}]*?prev:\s*\[([^\]]*)\]/g)) {
    const to = m[1];
    for (const f of m[2].matchAll(/'(\w+)'/g)) (out[f[1]] = out[f[1]] || []).push(to);
  }
  if (!Object.keys(out).length) throw new Error('STATUS_TRANSITIONS parsed empty');
  return out;
}

const DESKTOP = JSON.stringify(desktopMoves());
const SERVER  = JSON.stringify(serverMoves());

/* The phone's forward step lives in ORDER_NEXT, EXCEPT for pending_payment:
   marking an off-app payment asks which tender it was, so it is markPaid rather
   than a row in that table. Named here so the comparison is honest about it. */
const PHONE_SET = `(function(k){ var f=[]; if(k==='pending_payment') f.push('paid');
    if(ORDER_NEXT[k]) f.push(ORDER_NEXT[k].to);
    return f.concat(ORDER_ALSO[k]||[]).sort(); })`;

CASES.push(['the phone offers every move the desktop does, and no more', `
  window.__d=${DESKTOP}; window.__miss=[]; window.__extra=[];
  Object.keys(window.__d).forEach(function(k){
    var want=window.__d[k].slice().sort(), got=${PHONE_SET}(k);
    want.forEach(function(t){ if(got.indexOf(t)<0) window.__miss.push(k+'→'+t); });
    got.forEach(function(t){ if(want.indexOf(t)<0) window.__extra.push(k+'→'+t); });
  });`, [
  // This was six long before this change: refund from five statuses, cancel
  // from four, and paid→dispatched.
  ['nothing the desktop offers is missing here', `window.__miss.length===0 || 'missing '+window.__miss.join(', ')`],
  ['and nothing is offered that the desktop does not', `window.__extra.length===0 || 'extra '+window.__extra.join(', ')`],
  ['the desktop table was actually read', `Object.keys(window.__d).length>=6`],
]]);

CASES.push(['nothing is offered that the server would refuse', `
  window.__s=${SERVER}; window.__bad=[];
  Object.keys(ORDER_ALSO).forEach(function(k){ (ORDER_ALSO[k]||[]).forEach(function(to){
    if((window.__s[k]||[]).indexOf(to)<0) window.__bad.push(k+'→'+to); }); });`, [
  ['every move survives STATUS_TRANSITIONS', `window.__bad.length===0 || 'server refuses '+window.__bad.join(', ')`],
  ['the server table was actually read', `Object.keys(window.__s).length>=5`],
]]);

/* An order shaped however the case needs it, opened. */
const orderWith = (extra) => ONE_ORDER + `Object.assign(DB.orders[0],{_id:77},${extra});
  state.liveOrders=DB.orders; APP.cmd('tab','orders'); APP.cmd('openOrder',DB.orders[0].id);`;
const cmdIn = (acts, name) => `orderActs(currentOrder()).${acts}(function(a){return a[2].indexOf(${JSON.stringify(name)})>=0})`;

CASES.push(['a full refund takes the status path, which is the one that reverses points',
  orderWith(`{raw:'delivered', totalNum:312}`) + STUB
  + `APP.cmd('refundOrder'); APP.cmd('askRun','full'); APP.cmd('askRun','');`, [
  ['it PATCHes the status', `${sent('/orders/77/status')} && window.__sent.some(function(r){return r.m==='PATCH'})`],
  ['to refunded',           `${body('"status":"refunded"')}`],
  // /refund/direct with no amount settles the money and leaves the order
  // sitting at Delivered — the desktop keeps full on the status shortcut for
  // exactly this reason, and so does this.
  ['NOT down the direct path', `!${sent('/refund/direct')}`],
]]);

CASES.push(['a part refund posts the amount it was given',
  orderWith(`{raw:'delivered', totalNum:312}`) + STUB
  + `APP.cmd('refundOrder'); APP.cmd('askRun','amount');
     document.getElementById('ask-amount').value='50'; APP.cmd('askRun','');`, [
  ['it posts a direct refund', `${sent('/orders/77/refund/direct')}`],
  ['CARRYING THE AMOUNT',      `${body('"amount":50')}`],
  ['and never the status path', `!${sent('/orders/77/status')}`],
]]);

CASES.push(['more than the order total is refused on the phone, not at the server',
  orderWith(`{raw:'delivered', totalNum:312}`) + STUB
  + `APP.cmd('refundOrder'); APP.cmd('askRun','amount');
     document.getElementById('ask-amount').value='9999'; APP.cmd('askRun','');`, [
  ['nothing is sent',            `window.__sent.length===0`],
  ['the sheet stays open',       `!!state.ask`],
  ['and says why',               `!!state.askErr`],
]]);

CASES.push(['nor is nothing a refund',
  orderWith(`{raw:'delivered', totalNum:312}`) + STUB
  + `APP.cmd('refundOrder'); APP.cmd('askRun','amount');
     document.getElementById('ask-amount').value='0'; APP.cmd('askRun','');`, [
  ['nothing is sent', `window.__sent.length===0`],
  ['and it says why', `!!state.askErr`],
]]);

CASES.push(['cancelling records the reason the desktop asks for',
  orderWith(`{raw:'paid'}`) + STUB
  + `APP.cmd('cancelOrder'); document.getElementById('ask-reason').value='Customer changed their mind';
     APP.cmd('askRun','');`, [
  ['it PATCHes the status', `${sent('/orders/77/status')}`],
  ['to cancelled',          `${body('"status":"cancelled"')}`],
  // 23 orders in the live data carry a blank cancel reason. A phone that could
  // cancel without asking would be a second source of them.
  ['CARRYING THE REASON',   `${body('Customer changed their mind')}`],
]]);

CASES.push(['an unanswered reason goes as null, not as an empty string',
  orderWith(`{raw:'paid'}`) + STUB + `APP.cmd('cancelOrder'); APP.cmd('askRun','');`, [
  ['it still cancels', `${body('"status":"cancelled"')}`],
  ['reason is null',   `${body('"reason":null')}`],
]]);

CASES.push(['an unpaid order can be cancelled too',
  orderWith(`{raw:'pending_payment'}`) + STUB + `APP.cmd('cancelOrder'); APP.cmd('askRun','');`, [
  ['it cancels', `${body('"status":"cancelled"')}`],
]]);

CASES.push(['undo preparing asks, then posts',
  orderWith(`{raw:'preparing'}`) + STUB + `APP.cmd('undoPreparing'); APP.cmd('askRun','');`, [
  ['it posts undo-preparing', `${sent('/orders/77/undo-preparing')}`],
]]);

CASES.push(['and sends nothing until it is answered',
  orderWith(`{raw:'preparing'}`) + STUB + `APP.cmd('undoPreparing');`, [
  ['nothing yet', `window.__sent.length===0`],
  ['it asked',    `!!state.ask`],
]]);

CASES.push(['undo dispatch asks first now, as the desktop does',
  orderWith(`{raw:'dispatched'}`) + STUB + `APP.cmd('undoDispatch');`, [
  ['nothing is sent yet', `window.__sent.length===0`],
  ['it asked',            `!!state.ask`],
]]);

CASES.push(['and posts once it is answered',
  orderWith(`{raw:'dispatched'}`) + STUB + `APP.cmd('undoDispatch'); APP.cmd('askRun','');`, [
  ['it posts undo-dispatch', `${sent('/orders/77/undo-dispatch')}`],
]]);

CASES.push(['a walk-in is not offered an undo for a dispatch that never happened',
  orderWith(`{raw:'delivered', counter:true}`), [
  ['no undo row', cmdIn('every', 'undoDispatch').replace('>=0', '<0')],
]]);

CASES.push(['a delivery that really was dispatched still is',
  orderWith(`{raw:'delivered'}`), [
  ['the undo is there', cmdIn('some', 'undoDispatch')],
]]);

CASES.push(['a parcel with a waybill takes the undo away, as the server would',
  orderWith(`{raw:'dispatched', shipments:[{id:1,mode:'land',state:'dispatched',items:[],trk:{number:'JD123'}}]}`), [
  ['no undo row', cmdIn('every', 'undoDispatch').replace('>=0', '<0')],
]]);

CASES.push(["the shop is not offered a refund while the customer's own is in flight",
  orderWith(`{raw:'delivered', refundStatus:'approved'}`), [
  ['no direct refund',              cmdIn('every', 'refundOrder').replace('>=0', '<0')],
  ['the payout is offered instead', cmdIn('some', 'payRefund')],
]]);

/* THE ONE QUESTION THE DESKTOP ASKS BEFORE IT SHIPS. Not a state the machine
   can refuse — an order CAN go out early — so nothing but the ask stands
   between a Saturday order and a Wednesday van. */
CASES.push(['earlyShipFacts reads the promise, not the clock', `window.__f=[
   earlyShipFacts({fulfillment_type:'delivery', promised_ship_date:'${plus(3)}'}),
   earlyShipFacts({fulfillment_type:'delivery', scheduled_for:'${plus(5)} 09:00:00'}),
   earlyShipFacts({fulfillment_type:'delivery', scheduled_for:'${plus(1)} 09:00:00'}),
   earlyShipFacts({fulfillment_type:'pickup',   scheduled_for:'${plus(5)} 09:00:00'}),
   earlyShipFacts({fulfillment_type:'counter'}),
   earlyShipFacts({fulfillment_type:'delivery'})];`, [
  ['a batch not yet made is early',           `window.__f[0] && window.__f[0].kind==='fresh'`],
  ['a delivery well out is early',            `window.__f[1] && window.__f[1].kind==='late' && window.__f[1].days>2`],
  ['one day out is ordinary transit',         `window.__f[2]===null`],
  ['a pickup ships nothing to be early with', `window.__f[3]===null`],
  ['nor does a walk-in',                      `window.__f[4]===null`],
  ['and an order that promised nothing',      `window.__f[5]===null`],
]]);

/* The drawer paints from the LIST ROW on its first frame. A guard that only
   arrives with the detail read is absent for as long as that read takes, and
   the button is live the whole time. */
CASES.push(['the row carries the guard, not only the detail read', `
  window.__row=mapOrderRow({id:1,order_no:'RT-1',status:'preparing',channel:'wechat',recipient_name:'A',
    total:10, placed_at:'${today} 09:00:00', fulfillment_type:'delivery', scheduled_for:'${plus(6)} 09:00:00'});
  window.__near=mapOrderRow({id:2,order_no:'RT-2',status:'preparing',channel:'wechat',recipient_name:'B',
    total:10, placed_at:'${today} 09:00:00', fulfillment_type:'delivery', scheduled_for:'${plus(1)} 09:00:00'});`, [
  ['a far-off row is marked early', `!!window.__row.earlyShip && window.__row.earlyShip.kind==='late'`],
  ['a near one is not',             `window.__near.earlyShip===null`],
  ['and the row carries the total as a number too', `window.__row.totalNum===10`],
]]);

CASES.push(['a delivery days out is not dispatched without a question',
  orderWith(`{raw:'preparing', earlyShip:{kind:'late',day:'${plus(5)}',days:5,label:''}}`) + STUB
  + `APP.cmd('advance','dispatched');`, [
  ['nothing is sent', `window.__sent.length===0`],
  ['it asked',        `!!state.ask`],
]]);

CASES.push(['and goes once the question is answered',
  orderWith(`{raw:'preparing', earlyShip:{kind:'late',day:'${plus(5)}',days:5,label:''}}`) + STUB
  + `APP.cmd('advance','dispatched'); APP.cmd('askRun','');`, [
  ['it PATCHes to dispatched', `${body('"status":"dispatched"')}`],
]]);

CASES.push(['an order with nothing early about it is asked nothing',
  orderWith(`{raw:'preparing'}`) + STUB + `APP.cmd('advance','dispatched');`, [
  ['straight through', `${body('"status":"dispatched"')}`],
  ['no sheet',         `!state.ask`],
]]);

CASES.push(['and the question is only asked about dispatching',
  orderWith(`{raw:'paid', earlyShip:{kind:'late',day:'${plus(5)}',days:5,label:''}}`) + STUB
  + `APP.cmd('advance','preparing');`, [
  ['preparing is not shipping', `${body('"status":"preparing"')}`],
  ['so nothing is asked',       `!state.ask`],
]]);

CASES.push(['a read-only mirror carries none of them',
  orderWith(`{raw:'paid', viewOnly:true}`), [
  ['nothing at all', `orderActs(currentOrder()).length===0`],
]]);

CASES.push(['the More button appears when there is something behind it',
  orderWith(`{raw:'paid'}`), [
  ['a paid order has acts',     `orderActs(currentOrder()).length>0`],
  ['and the row draws the button', `orderActionRow(currentOrder(),false).indexOf("detailActions")>=0`],
]]);

/* ══════════════════════════════════════════════════════════════════════════
   §97 — THE SHOP NOTE, read and written

   The phone could write one while CREATING an order and then never see it
   again. The 2026-08-22 audit filed it as a decision — "no endpoint edits an
   existing order's note" — and that endpoint has existed for a while.
   ══════════════════════════════════════════════════════════════════════════ */

// An order as the DETAIL read returns it, mapped the way the app maps it.
const detailOrder = (extra) => `
  window.__o=mapDetail(Object.assign({id:77, order_no:'RT-077', status:'paid', channel:'wechat',
    recipient_name:'Chen Meiling', total:312, placed_at:'${today} 09:00:00',
    fulfillment_type:'delivery', items:[], shipments:[]}, ${extra}));
  state.liveDetail=window.__o; state.detailId=window.__o.id; state.ordNote=null;
  state.tab='orders'; render();`;

CASES.push(['the note is read from the order, not invented',
  detailOrder(`{staff_note:'Call before the van leaves'}`), [
  ['the card is drawn',        `document.getElementById('mOrdNote')!==null`],
  ['carrying the saved note',  `document.getElementById('mOrdNote').value==='Call before the van leaves'`],
  // Nothing has changed yet, so there is nothing to save.
  ['with no footer',           `document.getElementById('mOrdNoteFoot').hidden===true`],
]]);

CASES.push(['an order with no note still offers the field',
  detailOrder(`{}`), [
  ['the card is drawn', `document.getElementById('mOrdNote')!==null`],
  ['empty',             `document.getElementById('mOrdNote').value===''`],
]]);

/* THE LIST DOES NOT CARRY staff_note. Painting the box from a list row would
   show an empty note over an order that has one. */
CASES.push(['the card waits for the detail read rather than guessing', `
  state.liveDetail=null; state.ordNote=null;
  state.ordersView=[mapOrderRow({id:77,order_no:'RT-077',status:'paid',channel:'wechat',
    recipient_name:'A', total:312, placed_at:'${today} 09:00:00', fulfillment_type:'delivery'})];
  state.liveOrders=state.ordersView; state.ordersLoading=false;
  state.tab='orders'; APP.cmd('openOrder','RT-077');`, [
  ['the drawer is up',   `state.detailId==='RT-077'`],
  ['but no note box',    `document.getElementById('mOrdNote')===null`],
]]);

CASES.push(['a mirrored order gets none, as on the desktop',
  detailOrder(`{channel:'meituan', staff_note:'x'}`), [
  ['read-only',   `window.__o.viewOnly===true`],
  ['no note box', `document.getElementById('mOrdNote')===null`],
]]);

CASES.push(['typing shows the footer and never repaints',
  detailOrder(`{staff_note:'before'}`) + `
    window.__box=document.getElementById('mOrdNote');
    APP.cmd('ordNoteTyped','after');`, [
  ['the draft is held in state', `state.ordNote && state.ordNote.text==='after' && state.ordNote.id===77`],
  ['the footer appears',         `document.getElementById('mOrdNoteFoot').hidden===false`],
  // The same node, not a replacement: a repaint per keystroke would rebuild the
  // textarea under the caret.
  ['the textarea was not rebuilt', `document.getElementById('mOrdNote')===window.__box`],
]]);

CASES.push(['typing back to what was there hides the footer again',
  detailOrder(`{staff_note:'before'}`) + `APP.cmd('ordNoteTyped','after'); APP.cmd('ordNoteTyped','before');`, [
  ['nothing to save', `document.getElementById('mOrdNoteFoot').hidden===true`],
]]);

CASES.push(['saving PATCHes the note it was given',
  detailOrder(`{staff_note:'before'}`) + STUB + `
    document.getElementById('mOrdNote').value='after'; APP.cmd('ordNoteTyped','after');
    APP.cmd('ordNoteSave');`, [
  ['it PATCHes the note route', `${sent('/orders/77/note')} && window.__sent.some(function(r){return r.m==='PATCH'})`],
  ['CARRYING THE TEXT',         `${body('"staff_note":"after"')}`],
  ['and not the old one',       `!${body('"staff_note":"before"')}`],
]]);

/* A value the browser put there — an autofill, a paste the field answered with
   no input event — never reaches ordNoteTyped. Saving the draft instead of the
   box would write the older text back over it. */
CASES.push(['the box on screen wins over a stale draft',
  detailOrder(`{staff_note:'before'}`) + STUB + `
    APP.cmd('ordNoteTyped','typed');
    document.getElementById('mOrdNote').value='pasted by the browser';
    APP.cmd('ordNoteSave');`, [
  ['the box is what is sent', `${body('pasted by the browser')}`],
  ['not the draft',           `!${body('"staff_note":"typed"')}`],
]]);

CASES.push(['an emptied note is sent as the empty string, so the server can blank it',
  detailOrder(`{staff_note:'before'}`) + STUB + `
    document.getElementById('mOrdNote').value=''; APP.cmd('ordNoteTyped','');
    APP.cmd('ordNoteSave');`, [
  ['it still writes',    `${sent('/orders/77/note')}`],
  ['with an empty note', `${body('"staff_note":""')}`],
]]);

CASES.push(['cancel puts back what was saved',
  detailOrder(`{staff_note:'before'}`) + `APP.cmd('ordNoteTyped','after'); APP.cmd('ordNoteReset');`, [
  ['the box is restored', `document.getElementById('mOrdNote').value==='before'`],
  ['the draft is gone',   `state.ordNote===null`],
  ['and the footer',      `document.getElementById('mOrdNoteFoot').hidden===true`],
]]);

run('order writes', CASES);
