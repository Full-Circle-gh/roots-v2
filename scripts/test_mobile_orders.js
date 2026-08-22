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

const openOrder = (raw) => `DB.orders[0]._id=77; DB.orders[0].raw='${raw}';
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
   `DB.orders[0]._id=77; DB.orders[0].raw='paid'; DB.orders[0].refundStatus='approved';
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

run('order writes', CASES);
