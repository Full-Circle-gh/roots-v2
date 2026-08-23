#!/usr/bin/env node
/**
 * What the order sheet says about money and where the order ships from.
 *
 *   node scripts/test_mobile_payment.js
 *
 * Three rules, each of which the sheet has broken at least once:
 *
 *   • A routing reason is a column value, not a sentence. `only_store` — the
 *     reason meaning "there is one store, so it went there" — was printed
 *     verbatim under the store name, next to a route icon, as though an
 *     operator were meant to act on it. routingNotePair() speaks only when
 *     the routing was exceptional and is silent otherwise; the exceptional
 *     cases must keep speaking, which is why the second case is here.
 *   • The tender is a brand. It reads as the WeChat mark plus the word, and
 *     the status word is dropped when it merely repeats the Paid pill in the
 *     sheet's own title bar — and kept when it contradicts it.
 *   • A gateway transaction id is pasted, never read aloud. The card names
 *     what the button copies instead of printing thirty digits at 12.5px.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// One order, twice: the ordinary paid-by-WeChat single-store case, and the
// same order rerouted and refunded. The row is the test's own — the app ships
// no sample data.
const ORDER = (extra) => `{ id:'TC000375', _id:375, status:'paid', total:103, order_no:'TC000375',
  payment_method:'wechat',
  store_code:'TIANHE', store_name_en:'Tianhe', store_name_cn:'天河',
  recipient_name:'Chen', recipient_phone:'138****2841', address_full:'A road 1',
  fulfillment_type:'delivery', item_count:3, unit_count:3, items:[],
  created_at:'2026-08-23 10:00:00', ${extra} }`;

const PAID = ORDER(`routing_reason:'only_store',
  payments:[{status:'success',transaction_id:'4200002571202608231234567890'}]`);
const REROUTED = ORDER(`routing_reason:'fallback_no_stock',
  payments:[{status:'refunded',transaction_id:'4200002571202608231234567890'}]`);

const open = (row) => `state.liveDetail=mapDetail(${row});
  state.liveOrders=[state.liveDetail]; state.ordersView=state.liveOrders;
  state.tab='orders'; state.detailId='TC000375'; render();`;

const cases = [
  ['a single-store order says nothing about routing', open(PAID), [
    ['no raw enum on the glass', `sheetText().indexOf('only_store')===-1`],
    ['the store is still named', `sheetText().indexOf('Tianhe')>-1`],
  ]],
  ['the tender is the WeChat mark and the word', open(PAID), [
    ['named', `sheetText().indexOf('WeChat')>-1`],
    ['mark drawn', `document.querySelector('.sheet').innerHTML.indexOf('M9 4.2C5.2 4.2 2 6.8 2 10.1')>-1`],
    ['no status word repeating the Paid pill', `sheetText().indexOf('WeChat · paid')===-1`],
  ]],
  ['the transaction id is copied, not printed', open(PAID), [
    ['not on the card', `sheetText().indexOf('4200002571')===-1`],
    ['the button says what it copies', `sheetText().indexOf('Copy txn')>-1`],
  ]],
  ['an exceptional order still speaks', open(REROUTED), [
    ['the reroute reason, in words', `sheetText().indexOf('rerouted · out of stock')>-1`],
    ['a status that contradicts the pill is kept', `sheetText().indexOf('refunded')>-1`],
  ]],
];

run('order payment & routing', cases);
