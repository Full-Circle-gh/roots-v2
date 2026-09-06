#!/usr/bin/env node
/**
 * Add stock — the kitchen's other tool, now a screen in this app rather than a
 * separate PWA beside it.
 *
 *   node scripts/test_mobile_addstock.js
 *
 * The rules asserted here are the ones /stock learned the hard way, and each is
 * a decision rather than a detail. They are also all quiet when broken:
 *
 *   • THE SHELF TOTAL IS NEVER SHOWN. A kitchen logs what it MADE. Leak the
 *     running count onto this screen and the operator starts reconciling
 *     against a number that is somebody else's job.
 *   • THE STEPPER COMMITS ONCE. Taps build a "+N" and one delta is written
 *     after a pause. A write per tap puts six rows in the stock ledger where
 *     one belongs — and the ledger is what the shop reads back.
 *   • A FAILED WRITE HANDS THE AMOUNT BACK, in the row. Losing a count at the
 *     door is the one failure nobody forgives, and a toast that fades has told
 *     the operator nothing they can act on.
 *   • THE WIRE CARRIES A DELTA, never an absolute. The server refuses anything
 *     else from a kitchen operator (routes/retail-inventory.js kitchen_add_only)
 *     — a screen that sent physical_qty would simply not save.
 *
 * Needs a Chromium. Set CHROME_BIN, or let it find Playwright's.
 */
'use strict';

const { run } = require('./lib/m-probe');

// The operator this screen exists for: adds, does not recount, and receives.
const KITCHEN = "state.caps=['quickstock:add','purchasing:receive'];";

// The context and shelf the screen reads, seeded straight into state so the
// probe never needs a server. physical_qty is present ON PURPOSE — the screen
// is handed the shelf total and must still not draw it.
const SHELF = KITCHEN + `
  state.qs.ctx={enabled:true,mode:'add',stores:[{id:1,name_en:'Tianhe',name_cn:'天河'}]};
  state.qs.ctxTried=true; state.qs.storeId=1; state.qs.itemsTried=true;
  state.qs.items=[
    {product_id:7,name_en:'Hummus Asli',name_cn:'鹰嘴豆泥',sku:'1-10',physical_qty:11},
    {product_id:8,name_en:'Turkish Tomato Salad',name_cn:'土耳其番茄沙拉',sku:'1-15',physical_qty:0}
  ];
  state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`;

const body = "txt('content').replace(/\\s+/g,' ')";

/* THE SAME SHELF, WITH THE GRANT (decisions §46). Derived from SHELF rather
   than written out again, so the two fixtures cannot drift on anything but the
   one fact that separates them: whether this tenant has ticked
   `quickstock:recount` onto the kitchen role. The server sends the answer as
   `can_recount`; the screen never infers it from whether a quantity happened to
   arrive, because a stripped list and a genuinely empty shelf look the same. */
const GRANTED = SHELF.replace('render();', 'state.qs.canRecount=true; render();');

// A write recorder, for the cases that are about what goes on the wire.
const CATCH = `window.__sent=[];
  window.fetch=function(u,o){ window.__sent.push({u:String(u),b:o&&o.body});
    return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };`;

run('add stock', [
  ['it is a screen in this app, reached from the home',
    KITCHEN + "state.tab='more';state.stack=[];render();", [
      ['the home offers it', `${body}.indexOf('Add stock')>-1`],
      ['as a push, not a departure', "moreRowsFlat().some(function(r){return r.key==='stockapp'&&!r.href})"],
      ['and it lands on the in-app route', "moreRowsFlat().find(function(r){return r.key==='stockapp'}).cmd.indexOf('stockadd')>-1"],
    ]],
  ['an operator who recounts still leaves for the app that does that',
    "state.caps=['quickstock:recount'];state.tab='more';state.stack=[];render();", [
      ['named for the recount', `${body}.indexOf('Quick stock')>-1`],
      // A departure, and a deep link: the row lands on the counting list rather
    // than on the launcher that would offer it back (see #267).
    ['and it is a departure', "moreRowsFlat().find(function(r){return r.key==='stockapp'}).href==='/stock?go=add'"],
    ]],

  ['the shelf total never reaches the screen', SHELF, [
    ['the product is there', `${body}.indexOf('Hummus Asli')>-1`],
    ['its SKU is there', `${body}.indexOf('1-10')>-1`],
    ['the count starts at +0', `${body}.indexOf('+0')>-1`],
    ['11 is nowhere on it', `${body}.indexOf('11')===-1`],
  ]],
  ['the head names where it came from and which shelf',
    SHELF + "state.me={name:'R',role:'kitchen',roleName:{en:'Kitchen',cn:'后厨'}};render();", [
      ['back to the home by name', `${body}.indexOf('Kitchen')>-1`],
      ['the store is the status line', `${body}.indexOf('Tianhe')>-1`],
    ]],

  ['taps build one amount, and nothing is written yet',
    SHELF + "APP.cmd('qsBump',7,1);APP.cmd('qsBump',7,1);APP.cmd('qsBump',7,1);", [
      ['three taps read +3', "state.qs.add[7]===3"],
      ['on screen too', `${body}.indexOf('+3')>-1`],
      ['nothing is in flight', "!state.qs.inflight[7]"],
    ]],
  ['and it never goes below zero', SHELF + "APP.cmd('qsBump',7,-1);", [
    ['still +0', "state.qs.add[7]===0"],
  ]],

  ['the write is a DELTA — the server refuses anything else from a kitchen',
    SHELF + `window.__sent=[];
      window.fetch=function(u,o){ window.__sent.push({u:String(u),b:o&&o.body});
        return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve({success:true})}}); };
      APP.cmd('qsBump',7,2); qsFlush(7);`, [
      ['one request', "window.__sent.length===1"],
      ['to this store and product', "window.__sent[0].u.indexOf('/stores/1/stock/7')>-1"],
      ['carrying the delta', "JSON.parse(window.__sent[0].b).delta===2"],
      ['and never an absolute count', "!('physical_qty' in JSON.parse(window.__sent[0].b))"],
      ['the pending amount is cleared', "state.qs.add[7]===0"],
    ]],

  // The two ends of a write are asserted on their own. The probe runs its
  // checks in the same tick as its setup, so a settled promise is not
  // observable here — which is exactly why qsFlush hands its outcomes to two
  // named functions instead of two anonymous promise tails.
  ['a failed write hands the amount back, in the row',
    SHELF + "state.qs.inflight[8]=4; qsWriteFailed(8,4,'Server said no');", [
      ['the four are handed back', "state.qs.add[8]===4"],
      ['the row carries the failure', "state.qs.rowErr[8]==='Server said no'"],
      ['nothing is left in flight', "!state.qs.inflight[8]"],
      ['the message is on the screen', `${body}.indexOf('Server said no')>-1`],
      ['with a way to try again', `${body}.indexOf('Retry')>-1`],
      ['and the amount is still countable', `${body}.indexOf('+4')>-1`],
    ]],
  ['a write that lands leaves the row empty and says what went in',
    SHELF + "state.qs.inflight[7]=2; qsWriteLanded(7,2,state.qs.items[0]);", [
      ['nothing in flight', "!state.qs.inflight[7]"],
      ['nothing owed', "!state.qs.add[7]"],
      ['no error left over', "!state.qs.rowErr[7]"],
      ['and it names the amount and the product', "String(state.toast).indexOf('Added 2')>-1 && String(state.toast).indexOf('Hummus Asli')>-1"],
    ]],
  ['and the flush itself marks the row in flight and clears what is owed',
    SHELF + `window.fetch=function(){ return new Promise(function(){}); };
      APP.cmd('qsBump',7,3); qsFlush(7);`, [
      ['in flight for three', "state.qs.inflight[7]===3"],
      ['the pending amount is handed to the write, not kept', "state.qs.add[7]===0"],
    ]],

  ['a shop with the tool switched off says so, and does not draw a shelf',
    KITCHEN + `state.qs.ctx={enabled:false,stores:[]}; state.qs.ctxTried=true;
      state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`, [
      ['it says so', `${body}.indexOf('Add stock is off')>-1`],
      ['no search field', "!document.getElementById('mQsQ')"],
    ]],
  ['an operator with no store is told what is missing',
    KITCHEN + `state.qs.ctx={enabled:true,stores:[]}; state.qs.ctxTried=true;
      state.stack=[{route:'stockadd',title:SUBS.stockadd.title}]; render();`, [
      ['it says so', `${body}.indexOf('No store assigned')>-1`],
    ]],
  ['search narrows the shelf without losing the caret',
    SHELF + "APP.cmd('qsSearch','tomato');", [
      ['only the match', `${body}.indexOf('Turkish Tomato Salad')>-1 && ${body}.indexOf('Hummus')===-1`],
      ['the field keeps focus', "document.activeElement && document.activeElement.id==='mQsQ'"],
    ]],
  /* ── §46: the count, and the one correction it allows ────────────────────
     WITHOUT THE GRANT NOTHING CHANGED — asserted by the case above this block,
     which is every kitchen until an owner ticks the capability on. */
  ['without the grant there is no correction door', SHELF, [
    ['no shelf line', `${body}.indexOf('On the shelf')===-1`],
    ['and nothing to open', `${body}.indexOf('Correct the count')===-1`],
  ]],
  ['the grant shows the count and opens the door', GRANTED, [
    ['the shelf figure is named', `${body}.indexOf('On the shelf')>-1`],
    ['and it is the shelf figure', `${body}.indexOf('11')>-1`],
    ['with a way to correct it', `${body}.indexOf('Correct the count')>-1`],
  ]],
  /* WHAT HAS ALREADY GONE ON TODAY. The half that needs NO grant — it is the
     operator's own work read back, and it is what stops the same batch going
     on twice. Zero is not drawn: "Added today +0" on two hundred cards trains
     the eye to skip the line on the one card where it says something. */
  ['todays adds are read back on the card',
    SHELF + "state.qs.addedToday={7:6}; render();", [
      ['the line is there', `${body}.indexOf('Added today')>-1`],
      ['carrying what went on', `${body}.indexOf('+6')>-1`],
    ]],
  ['and it is absent when nothing went on', SHELF, [
    ['no line', `${body}.indexOf('Added today')===-1`],
  ]],

  /* A DROP IS NEVER SAVED UNASKED. 11 on the shelf, 8 counted: the fork opens
     and the wire stays silent until it is answered. */
  ['a drop asks before it writes', GRANTED + CATCH + "qsCountEntered(7,8);", [
    ['the fork is open', "!!state.ask"],
    ['offering the miscount', "state.ask.options.some(function(o){return o.key==='miscount'})"],
    ['and the loss', "state.ask.options.some(function(o){return o.key==='gone'})"],
    ['carrying no waste vocabulary at all',
      "state.ask.options.every(function(o){return ['miscount','gone'].indexOf(o.key)>-1})"],
    ['and nothing has been written', "window.__sent.length===0"],
  ]],
  /* THE ANSWER THAT WRITES NOTHING. The kitchen records no waste, so a loss
     stops here and goes to whoever can record one — and the screen says so
     rather than merely refusing. */
  ['something gone writes nothing and says where it goes',
    GRANTED + CATCH + "qsCountEntered(7,8); APP.cmd('askRun','gone');", [
      ['nothing on the wire', "window.__sent.length===0"],
      ['the shelf is untouched', "state.qs.items[0].physical_qty===11"],
      ['and it says what happens instead', "String(state.toast).indexOf('records waste')>-1"],
    ]],
  ['counted wrong writes an absolute count carrying the answer',
    GRANTED + CATCH + "qsCountEntered(7,8); APP.cmd('askRun','miscount');", [
      ['one request', "window.__sent.length===1"],
      ['an absolute count, never a delta', "JSON.parse(window.__sent[0].b).physical_qty===8"],
      ['the two writes stay two', "!('delta' in JSON.parse(window.__sent[0].b))"],
      ['and it carries the fork answer', "JSON.parse(window.__sent[0].b).recount_reason==='miscount'"],
    ]],
  /* A RISE ASKS NOTHING (§46), ruled that way against the symmetry argument on
     the friction case — so a fork appearing here is a decision reversed in
     silence. And no answer rides along: an upward correction was never asked. */
  ['raising the count asks nothing and claims nothing',
    GRANTED + CATCH + "qsCountEntered(7,19);", [
      ['no fork', "!state.ask"],
      ['one request', "window.__sent.length===1"],
      ['carrying the new count', "JSON.parse(window.__sent[0].b).physical_qty===19"],
      ['and no answer nobody was asked for', "!('recount_reason' in JSON.parse(window.__sent[0].b))"],
    ]],
  ['a count that agrees with the shelf writes nothing at all',
    GRANTED + CATCH + "qsCountEntered(7,11);", [
      ['no fork', "!state.ask"],
      ['and no write', "window.__sent.length===0"],
    ]],

  ['a role without the permission cannot reach it at all',
    "state.caps=['purchasing:receive'];push('stockadd');render();", [
      ['push refuses it', "state.stack.length===0"],
      ['and the home does not offer it', `${body}.indexOf('Add stock')===-1`],
    ]],
]);
